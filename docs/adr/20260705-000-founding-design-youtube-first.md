---
adr: "000"
title: "postctl founding design — YouTube-first"
date: 2026-07-05
status: accepted
postctl_version: "0.1.0"
tags: [postctl, youtube, auth, architecture]
---

# ADR-000: postctl founding design — YouTube-first

## Decision

Build `postctl`, a kubectl-style, agent-first CLI that posts content to the Big 5
platforms via official OAuth APIs — **YouTube ships first**, then Instagram and
Facebook Pages, then X and LinkedIn. Core (config, token store, auth engine,
output, HTTP wrapper) is written once; providers are request-shaping only.
Zero external dependencies, Bun + TypeScript, no daemon/queue/database.

This supersedes the roadmap's X-first ordering (`docs/research/roadmap.md` P1).
Full evidence base: `docs/research/research-20260703.md`; general architecture:
`docs/research/design.md`. This ADR records only what changed and what the
YouTube slice pins down.

## Context

- Primary driver: Isha Yoga Center video publication / content team needs
  posting automation now. Their demand ranking is YouTube > Instagram/Facebook.
- YouTube-first means the auth engine, `standard` refresh, and the hardest
  media path (resumable upload) land together instead of being eased in via X.
  Accepted: the payoff is a usable tool for the real user after one provider.
- frappe-ctl (v0.3.0, 28 ADRs) is the pattern donor. Ported wholesale:
  config-functions-not-constants (ADR-004), PKCE OAuth + fixed-port loopback
  (ADR-009/011), keychain + 0o600 token store (ADR-003), TTY/agent output
  detection (ADR-008/023), credential-leak boundary (ADR-020), exit-code
  contract 0/1/4 (ADR-022), bin-wrapper symlink resolution (ADR-026).

## YouTube slice — pinned decisions

### Auth

- Google OAuth 2.0, **installed-app flow**: authorization code + PKCE S256 +
  fixed-port loopback redirect (`http://localhost:8917`).
- Google "Desktop app" clients are issued a `client_secret` that Google's docs
  explicitly say is "not treated as a secret" for installed apps — but the
  token endpoint still **requires** it alongside PKCE. So the profile stores
  `client_id` + `client_secret`; the secret lives in the token store, not
  `profiles.json`. Auth kind is `oauth` (PKCE) with `clientSecret: "required"`.
- Scopes: `youtube.upload` + `youtube.readonly` (verify/whoami needs
  `channels.list mine=true`, which upload scope alone cannot call).
- Refresh strategy: `standard` (`grant_type=refresh_token`). Google refresh
  tokens are durable **only when the OAuth consent screen is in Production**;
  Testing mode kills them after 7 days. Setup docs make Production a hard
  prerequisite, and `auth login` prints the warning.

### Team model (Isha)

- One GCP project + one OAuth client serves the whole team (client_id/secret
  are shareable — PKCE carries the security). Each operator runs
  `postctl auth login youtube` on their own machine and grants their own
  Google account; channel access is whatever YouTube already grants them
  (channel permissions / brand-account roles). No shared refresh tokens —
  tokens never leave the operator's keychain.
- Profiles are named accounts: `postctl auth login youtube --account isha`.
  Multiple channels = multiple profiles.

### Upload

- `videos.insert` with `uploadType=resumable`: initiate → `Location` session
  URL → PUT bytes; on interrupt, query offset (`Content-Range: bytes */N`,
  expect 308) and resume. Bounded resume attempts (5), no infinite loops.
- Quota: 10,000 units/day per project; upload = 1,600 units ⇒ **~6 uploads/day**.
  `validate` and `--debug` print quota arithmetic. If Isha's volume exceeds
  this, the documented path is a quota-increase request on the audited project.
- **Unaudited API projects upload as Private regardless of requested status**
  (projects created after Jul 2020). Default `--privacy private`; result always
  prints the Studio link for manual publish. The compliance audit application
  is a documented week-1 parallel track, not a blocker.

### Post grammar mapping

```
postctl post --account isha --media ./talk.mp4 "Title of the video" \
  --description ./desc.txt --tags "sadhguru,isha" --privacy private
```

Positional text = video title (YouTube: ≤100 chars, no `<` or `>`).
`--description` accepts a literal string or a file path (descriptions are long;
files keep shell-quoting sane). Capabilities declare `video: required`,
`text: required` — `validate` enforces offline before any quota is spent.

## Consequences

- ✅ First shipped provider serves the real user (Isha team) directly.
- ✅ Hardest media path (resumable upload) proven first; IG staging (P1 next)
  is the only remaining media pattern.
- ⚠️ Public uploads gated on Google's compliance audit — until then the tool
  is "upload private + human publishes in Studio". Documented, not hidden.
- ⚠️ 6 uploads/day/project default quota may be under Isha's volume — measure,
  then request increase.
- ⚠️ X-first simplicity forfeited: auth engine must be right on the first
  provider. Mitigated by porting frappe-ctl's tested OAuth core.
