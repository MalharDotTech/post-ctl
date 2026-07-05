---
adr: "000"
title: "socialctl — founding design (ADR init)"
date: 2026-07-03
status: proposed
frappe_ctl_version: "0.3.0"
tags: [socialctl, auth, architecture, media-staging]
---

# socialctl — Founding Design Document

**Purpose of this file:** hand a later session everything needed to initiate the build with zero re-research. Companion docs: `research-20260703.md` (evidence), `roadmap.md` (sequencing).

## Decision

Build `socialctl`, a kubectl-style, agent-first, human-auditable CLI that posts content to **Instagram, Facebook Pages, YouTube, X, and LinkedIn** using each platform's official OAuth APIs — auth implemented once per *kind* (not per platform), refresh declared as data, no daemon/queue/database, media staged through a user-owned S3/R2 bucket.

## Context

- Postiz proves the official-API route works but carries a 4-service stack (NestJS/Postgres/Redis/Temporal) and ~17k LOC of provider code, most of it features we don't want (analytics, comments, scheduling UI). Self-hosting it does **not** remove the per-platform developer-app setup.
- Browser-session automation is rejected as a core path: Instagram/LinkedIn restrict accounts on fingerprint/session mismatch; selector churn is unbounded maintenance. (Evidence in research doc §4.)
- Buffer's new GraphQL API (beta, personal keys) is a useful fallback provider, not a foundation — beta, no video upload, revocable (they shut their API once in 2019).
- Maintainers: two people. Every choice optimizes bounded maintenance over coverage.
- frappe-ctl is the pattern donor: profiles, PKCE OAuth, keychain token store, pipe-safe output, exit-code contract, MCP gating are all proven there.

## Grammar

```
socialctl [--account <profile>|<alias>] <verb> [args] [flags]

socialctl auth login <provider> --account work.x     # runs declared auth kind
socialctl auth status [--output json]                # per-profile expiry dashboard
socialctl post --account personal.x "text" [--media ./img.jpg] [--link URL]
socialctl post --account everywhere "text"           # alias fan-out, batch result
socialctl validate --account biz.ig --media ./img.jpg "caption"   # offline pre-flight
socialctl accounts list|add|remove
socialctl agent-context                              # static schema, no network
```

Verbs are platform-agnostic; providers translate. `--enable-verbs` and `--readonly` gate the surface (frappe-ctl ADR-018 + gog pattern).

## System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ cli.ts — arg parse, verb router, --enable-verbs/--readonly     │
│          gates, exit-code mapping, silent lazy refresh          │
└──────┬─────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────── core (written once) ────────────────────┐
│ config.ts        profiles.json via configDir() functions        │
│                  (SOCIALCTL_CONFIG_DIR read at call time)       │
│ token-store.ts   keychain + 0o600 file fallback,               │
│                  key = <provider>/<profile>                     │
│ auth/            3 auth kinds: token | oauth(pkce) |            │
│                  oauth-secret; loopback redirect server         │
│ refresh.ts       4 strategies as data: none | standard |        │
│                  exchange | reauth  → AuthRequiredError (exit 4)│
│ http.ts          wrappedFetch: bounded retry 429/5xx,           │
│                  401→AuthRequiredError, credential-leak         │
│                  boundary (no secret ever in error text)        │
│ stage.ts         media staging: S3/R2 SigV4 presign (see below) │
│ output.ts        detectFormat: flag > agent env > TTY;          │
│                  table for humans, JSON for pipes/agents        │
│ agent-detect.ts  isAgentInvocation() — port from frappe-ctl     │
└──────┬──────────────────────────────────────────────────────────┘
       │ Provider interface (request-shaping ONLY)
┌──────▼──────────────────────────────────────────────────────────┐
│ providers/x.ts  linkedin.ts  facebook.ts  instagram.ts          │
│ youtube.ts  (buffer.ts — optional fallback)                     │
│ one file + one colocated test each; no provider imports another │
└──────┬──────────────────────────────────────────────────────────┘
       ▼
   Platform APIs (official only)
```

No background process anywhere. Scheduling belongs to `cron`/CI/the invoking agent.

## Auth Engine

### Auth kinds (implemented once, declared per provider)

| Kind | Platforms (Big 5 scope) | Mechanism |
|---|---|---|
| `oauth` (PKCE, public client) | X, Facebook, Instagram, YouTube | Auth-code + PKCE S256, fixed-port loopback redirect (frappe-ctl ADR-009/011) |
| `oauth-secret` | LinkedIn | Same flow, client secret from profile (user's own single-user app — same trust level as frappe-ctl api_secret) |
| `token` | (Buffer fallback; future providers) | Paste once → token store |

### Refresh strategies (data, not code)

| Strategy | Platforms | Invocation-time behavior |
|---|---|---|
| `standard` | X, YouTube | `grant_type=refresh_token` when access token within 5-min expiry window |
| `exchange` | Instagram, Facebook | Meta long-lived exchange (`ig_refresh_token` / `fb_exchange_token`); ALSO refresh opportunistically whenever token age > 30d, so any use inside 60 days keeps it alive forever |
| `reauth` | LinkedIn | Not refreshable (partner-gated). Expiry → `AuthRequiredError`, exit 4, message names the exact command to run |
| `none` | (token-kind providers) | Use as-is |

Refresh failure ⇒ mark profile `refresh_needed`, exit 4. Never retry-loop, never prompt. `auth status` prints per-profile days-to-expiry so a weekly agent cron can warn about the LinkedIn wall and idle Meta tokens.

### Platform behavior contract (must ship in user docs + skill file)

| Platform | Re-login cadence | Non-negotiables the user must know |
|---|---|---|
| X | never (rotating refresh) | Pay-per-use: $0.015/post, $0.20/post containing a link; card on developer account |
| LinkedIn | every 60 days (policy) | Member profile only; org pages are review-gated (out of scope) |
| Facebook | effectively never | **Pages only** — personal timeline is API-dead since 2018 |
| Instagram | never IF used ≥ once/60d | Business/Creator account required; media required (no text-only); media pulled from public URL |
| YouTube | never (consent screen must be "Production" or refresh dies in 7 days) | Unaudited GCP project ⇒ uploads **forced Private**; default behavior: upload private + print Studio publish link; pursue compliance audit in parallel. Quota 10k units/day ⇒ 6 uploads/day |

## Provider Interface

```typescript
export type AuthSpec =
  | { kind: "token"; fields: { name: string; label: string; secret: boolean }[] }
  | { kind: "oauth"; authUrl: string; tokenUrl: string; scopes: string[];
      pkce: boolean;                       // false ⇒ client secret from profile
      refresh: "none" | "standard" | "exchange" | "reauth";
      refreshUrl?: string };               // Meta exchange endpoints

export interface Capabilities {
  text: { maxChars: number; required: boolean };
  images?: { max: number; formats: string[]; maxBytes: number };
  video?: { formats: string[]; maxBytes: number };
  link?: "inline" | "attachment" | "unsupported";
  mediaSource: "upload" | "public-url";    // public-url ⇒ stage.ts involved
}

export interface Post {
  text: string;
  media?: { path: string; alt?: string }[];
  link?: string;
  replyToId?: string;
}
export interface PostResult { id: string; url?: string }
export interface AccountInfo { id: string; username: string; displayName?: string }

export interface Provider {
  id: string;
  auth: AuthSpec;
  capabilities: Capabilities;
  post(ctx: AuthedCtx, post: Post): Promise<PostResult>;
  verify(ctx: AuthedCtx): Promise<AccountInfo>;   // auth status / whoami
  del?(ctx: AuthedCtx, id: string): Promise<void>;
}
// AuthedCtx = { fetch: wrappedFetch; profile: Profile; stage?: (file) => Promise<StagedUrl> }
// Providers never see raw tokens — wrappedFetch injects auth headers.
```

Rules: providers contain request-shaping only (endpoints, payload mapping, `handleErrors`-style interpretation). Auth, refresh, retry, storage, staging, output all live in core. Target 150–400 LOC/provider vs Postiz's 450–1,100.

## Media Staging (S3/R2)

Instagram (and Buffer's `imageUrl`, and TikTok if ever added) **pull media from an HTTPS URL during publish** — a local CLI must stage files first. X/LinkedIn/YouTube upload directly and never touch this path.

```
socialctl post --account biz.ig "caption" --media ./photo.jpg
  │
  ├─ 1. stage.ts: SigV4 PUT  ./photo.jpg → s3://bucket/socialctl/<uuid>.jpg
  ├─ 2. mint presigned GET URL, TTL 1h    (bucket stays fully PRIVATE)
  ├─ 3. provider: IG container create(image_url=<presigned>) → publish → poll status
  └─ 4. on confirmed publish: DELETE object (best-effort; TTL is the backstop)
```

Config (`profiles.json → staging` block; secret key in token store, not the file):

```jsonc
"staging": {
  "backend": "r2",                    // "r2" | "s3" | "none"
  "endpoint": "https://<acct>.r2.cloudflarestorage.com",
  "bucket": "socialctl-staging",
  "region": "auto",
  "accessKeyId": "…",                 // secretAccessKey lives in token store
  "prefix": "socialctl/",
  "presignTtlSeconds": 3600
}
```

Implementation notes:
- SigV4 signing hand-rolled on `crypto.subtle`/Bun crypto — ~150 LOC, keeps the zero-external-deps rule. R2 and S3 share the algorithm; only endpoint/region differ.
- Presigned **GET** (not a public bucket): nothing is ever world-readable beyond a 1h expiring URL, and cleanup failure is bounded by TTL + an optional bucket lifecycle rule (document: set 1-day expiry lifecycle on the bucket).
- Escape hatch: `--media-url <https://…>` skips staging entirely (user already hosts the asset). `backend: "none"` + local file + public-url provider ⇒ hard error with exit 1 naming the fix.
- `validate` checks staging config presence offline for `public-url` providers.

## Error Taxonomy / Exit Codes (frappe-ctl ADR-022 carried forward)

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | validation failure / platform API error (stderr message; structured JSON on stdout where applicable) |
| 4 | auth required — missing profile, expired non-refreshable token, HTTP 401. LinkedIn's 60-day wall lands here by design; agents branch on it |

Batch (`--account <alias>`) never aborts on per-target failure: result is `{ total, success, failed, errors: [{account, error}] }`, exit 0 if any succeeded... **decide at build time** (recommend: exit 1 if `failed > 0`, result JSON always printed — agent gets both signal and detail).

## Security Invariants (day-one regression tests, per frappe-ctl ADR-020)

1. No token/secret/refresh-token value ever appears in thrown error text, `--debug` output, or stdout. Port the credential-leak test matrix (HTTP-error, network-failure, malformed-JSON paths).
2. `--debug` names the active profile + auth path, never values.
3. Token store: keychain first, `0o600` file fallback, `SOCIALCTL_NO_KEYCHAIN=1` for CI.
4. Config functions not constants (`SOCIALCTL_CONFIG_DIR` read at call time) — test isolation depends on it.

## Testing Strategy (inherited)

BDD→TDD; tests colocated; `spyOn(globalThis, "fetch")` mocks, never re-spy; fixtures in `__fixtures__/`; every provider ships happy-path + flag + table/JSON output tests; a `skill-file.test.ts`-equivalent keeps provider list ↔ docs ↔ skill file in sync (ADR-025 pattern); loopback OAuth flow tested with an in-process redirect hit.

## Consequences

- ✅ Auth ceremony bounded: 5 one-time developer-app setups (~30–60 min each, documented per provider); after that only LinkedIn requires periodic human action (60d), and `auth status` makes it predictable.
- ✅ No infrastructure: binary + config dir + optional private bucket. Nothing to babysit.
- ✅ Every provider replaceable in isolation; Buffer/aggregators slot in as ordinary providers.
- ⚠️ Staging bucket is a new user-supplied dependency for Instagram specifically.
- ⚠️ YouTube public uploads depend on a Google audit outcome we don't control; default private-then-publish behavior must be prominently documented.
- ⚠️ X posting has per-post cost; the CLI should print cost hints in `validate`/`--debug`.
