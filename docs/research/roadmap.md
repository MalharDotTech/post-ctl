# socialctl — Prioritized & Bucketed Roadmap

**North star:** an agent-first, human-auditable CLI in the lineage of [frappe-ctl](https://github.com/MalharDotTech/frappe-ctl) and [gog / gogcli.sh](https://gogcli.sh/) — same commands for humans, scripts, CI, and agents; JSON when piped, tables on a TTY; stable exit codes; explicit safety boundaries; typed MCP surface; no interactive prompts in the write path.

Buckets are priority-ordered. Nothing in a later bucket starts before the earlier bucket's exit criteria are met. Scope: **Instagram, Facebook Pages, YouTube, X, LinkedIn** (Big 5). Bluesky/Mastodon/Threads: explicitly out.

---

## P0 — Foundation (exit: `socialctl auth login x && socialctl post` works end-to-end)

| # | Item | Reference pattern |
|---|---|---|
| 0.1 | Repo init: Bun + TS, zero external deps, BDD→TDD, colocated tests | frappe-ctl ADR-003 |
| 0.2 | `config.ts` — profiles as **functions not constants** (`SOCIALCTL_CONFIG_DIR` at call time) | frappe-ctl ADR-004 |
| 0.3 | `token-store.ts` — keychain + `0o600` file fallback, `SOCIALCTL_NO_KEYCHAIN` | frappe-ctl port |
| 0.4 | Auth engine: `oauth` (PKCE + loopback) and `oauth-secret` kinds; refresh strategies `standard`/`exchange`/`reauth` as data | frappe-ctl `oauth.ts`, ADR-009/011 |
| 0.5 | `http.ts` wrappedFetch: bounded 429/5xx retry, 401→`AuthRequiredError` (exit 4), **credential-leak boundary + regression test matrix from day one** | frappe-ctl ADR-020/022 |
| 0.6 | `output.ts` + `agent-detect.ts` ports: flag > agent env var > TTY | frappe-ctl ADR-008/023 |
| 0.7 | Provider interface (`design.md` §Provider Interface) + `x.ts` as the proving provider | — |
| 0.8 | `auth status` — per-profile expiry dashboard, `--output json` | gog `auth status` UX |

## P1 — Big-5 providers (exit: all five post from CLI + documented behavior contract)

Order chosen by dependency, not alphabet:

1. **X** (P0.7) — simplest OAuth, direct upload; surfaces per-post cost in `validate`/`--debug`.
2. **LinkedIn** — `oauth-secret` kind + the `reauth` strategy end-to-end (exit-4 UX, days-to-expiry warning).
3. **Facebook Pages** — Meta dev-mode app, `exchange` refresh, page-token derivation.
4. **Media staging (`stage.ts`)** — S3/R2 SigV4 presign (~150 LOC, zero-dep), presigned-GET private-bucket flow, `--media-url` escape hatch, bucket lifecycle-rule docs.
5. **Instagram** — depends on 3 + 4. Business-account preflight in `validate`.
6. **YouTube** — resumable upload; **default: upload Private + print Studio publish link**; docs page for the compliance-audit application; quota hint (6 uploads/day).
7. `validate` verb — offline capability checks (char limits, media presence/format, staging config) with `--output json {valid, errors[]}`, exit 1 on fail.
8. Behavior-contract docs per platform (the table in design.md) shipped as `docs/platforms/*.md` — "users well informed" is a release gate, not an afterthought.

## P2 — Agent-first surface (exit: an agent can operate it safely without supervision)

| # | Item | Reference pattern |
|---|---|---|
| 2.1 | `socialctl agent-context` — static CLI schema, no network, early-return path | frappe-ctl `agent-context.ts` |
| 2.2 | `socialctl.skill.md` + `skills install` verb; freshness test binding CLI verbs ↔ skill ↔ docs | frappe-ctl ADR-021/025 |
| 2.3 | `--enable-verbs` allowlist + `--readonly` runtime enforcement (blocks `post`/`del` at the router) | frappe-ctl ADR-018; gog runtime `--readonly` |
| 2.4 | Typed MCP server (stdio): read-only tools default (`accounts`, `auth_status`, `validate`), mutations behind `--allow-mutations`; **no generic shell/argv bridge, no untyped "call" tool** | frappe-ctl MCP scope rules; gog typed-MCP stance |
| 2.5 | Dry-run: `post --dry-run` prints the exact per-platform payload (full data, no sparse filters on previews) | frappe-ctl Dev-Agent Don'ts |
| 2.6 | Batch fan-out result contract `{total, success, failed, errors[]}`, never abort-on-first | frappe-ctl bulk verb |
| 2.7 | Cost/quota guards: `--max-cost-usd` for X, quota warnings for YouTube | gog "baked safety profiles" spirit |

## P3 — Aesthetics & human auditability (exit: pleasant on a TTY, boring in a pipe)

- TTY tables with aligned columns; **zero decoration when piped** (bit-stable JSON) — the split is the aesthetic.
- `auth status` as the flagship human view: per-account row, days-to-expiry, colored only on TTY (respect `NO_COLOR`).
- Error messages that name the fix: every exit-4 prints the exact command to run; every staging error names the config key.
- `--debug` prints profile/auth-path/endpoints, never secret values; post results always echo the live post URL.
- Audit trail: `--log-file` appends JSONL of every mutation (timestamp, account, verb, post id, url) — human-auditable history without a database.
- Docs site in the gogcli.sh mold: a single **spec page** (all verbs/flags/exit codes on one page, curl-able as plain text for agents) + per-platform behavior pages.

## P4 — Distribution (exit: `curl -fsSL … | sh` and `npm i -g` both work)

- `bun build --compile` single-binary releases (macOS arm64/x64, Linux x64/arm64) via GitHub Actions on tag.
- npm package with bin wrapper — **symlink-resolving wrapper from day one** (this bit frappe-ctl; regression test exists to copy) — frappe-ctl ADR-026.
- Install script + Homebrew tap (gogcli.sh `install.html` as the model).
- Shell completions (bash/zsh/fish) generated from the verb table.
- Versioning: `package.json` is the single source; README/ADRs/agent-context derive from it (frappe-ctl rule).

## P5 — Deferred / watch list (explicitly NOT scheduled)

- **Buffer provider** (`token` kind, ~150 LOC) — build only if a Big-5 native path stalls (e.g., waiting on YouTube audit) or as a zero-setup demo mode. Re-check their beta's video support first.
- **Aggregator provider** (Late-class) — same slot, same interface; decision is pricing, not architecture.
- **Browser/CDP fallback** — rejected as core (research doc §4); revisit only if a platform kills its API, and then only CDP-attach + opt-in + never IG/LinkedIn.
- **Scheduling** — permanently out; `cron`/CI/agents own time. A `--at` flag that shells to `at(1)` is the most we ever ship.
- **Threads/Bluesky/Mastodon providers** — trivially easy (token-kind), deliberately parked; add only on real demand since each is <1 day of work under this interface.
- **Watch items:** X pricing churn (quarterly check), Meta Graph version deprecations (~yearly bump), LinkedIn partner-program changes (would unlock refresh tokens), YouTube audit outcome.

---

## P6 — Post-publish mutation (edit already-shipped content) — requested, not yet scheduled

Today every provider only *creates* (`post`). A distinct capability class:
editing content that is already live. Driven by real demand (Isha content
team: fix a YouTube title/description/thumbnail after upload without opening
Studio).

- **`update <id>` verb** — patch an existing post's metadata. YouTube first:
  `videos.update` (part=snippet,status) for title, description, tags, category,
  privacy. Provider gains an optional `update?(ctx, id, patch)` method; core
  routes the verb, providers that don't support it return a clean "unsupported"
  (exit 1). No new OAuth scope for YouTube — `youtube.upload` already covers
  `videos.update`.
- **`thumbnail <id> --image <file>` verb** — YouTube `thumbnails.set` (direct
  multipart upload, not URL-pull, so no staging). **Caveat:** `thumbnails.set`
  requires the channel to be **verified** (phone-confirmed); unverified
  channels get a 403. Surface that as a named error, not a crash.
- **Mapping to other platforms (when built):** IG/FB captions are largely
  immutable via API (FB feed post message can be edited via `POST /{post-id}`;
  IG captions cannot) — `update` stays provider-capability-gated, never
  pretends universality.
- **Design constraints:** same interface discipline as `post` (request-shaping
  only in providers); `update --dry-run` prints the exact patch; `validate`
  extends to check field limits offline; mutation is gated by `--enable-verbs`
  / `--readonly` like `post`/`del` (P2.3).

---

## Reference index (why these two tools)

| Pattern to copy | frappe-ctl | gog (gogcli.sh) |
|---|---|---|
| Profiles / multi-account | `--site` profiles, `config.ts` | multi-account auth |
| Pipe-safe output | ADR-008/023, `agent-detect.ts` | JSON/TSV everywhere |
| Exit-code contract | 0/1/4 (ADR-022) | stable exit codes |
| Credential hygiene | ADR-020 leak-boundary tests | — |
| Surface gating | `--enable-verbs` (ADR-018) | runtime `--readonly`, allow/deny rules, safety-profile binaries |
| Typed MCP, no shell bridge | 5 read-only + 3 mutations, `--allow-mutations` | typed MCP, read-only default |
| Agent docs freshness | skill file + ADR-025 test | one-page spec at gogcli.sh/spec.html |
| Distribution | npm bin wrapper (ADR-026) | install script + docs site |
