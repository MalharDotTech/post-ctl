# postctl — development guide

kubectl-style CLI posting to Big-5 social platforms via official OAuth APIs.
Agent-first, human-auditable. Lineage: [frappe-ctl](https://github.com/MalharDotTech/frappe-ctl)
(pattern donor — its ADRs are cited throughout as "frappe-ctl ADR-NNN").

## Commands

```sh
bun test              # full suite (fast, all network mocked)
bunx tsc --noEmit     # typecheck
bun run src/cli.ts    # run CLI locally
```

## Architecture (one paragraph)

`cli.ts` routes verbs and owns the exit-code contract. Core modules
(`config`, `token-store`, `oauth`, `http`, `stage`, `output`, `args`,
`errors`) are written once and provider-agnostic. Providers
(`src/providers/*.ts`) are request-shaping only — endpoints, payload mapping,
error interpretation; optional `finalizeAuth` hook for post-OAuth steps (Meta
long-lived exchange, FB page-token derivation). Providers never see raw
tokens: `http.ts::createAuthSession` returns a closure-held authed fetch that
injects headers, refreshes lazily (`standard` grant or Meta `exchange`),
retries 429/5xx bounded, and maps 401 → `AuthRequiredError`. `stage.ts`
(SigV4 presign, R2/S3) feeds `mediaSource: "public-url"` providers — verified
against the AWS SigV4 test vector. No daemon, no queue, no database, zero
runtime dependencies.

## Hard rules

- **Zero external dependencies.** Bun built-ins + Web APIs only.
- **Exit codes**: 0 success · 1 validation/API failure · 4 auth required.
  Only `cli.ts` (and `validateCmd`/`doctorCmd`) set `process.exitCode`. Never `process.exit()`.
- **Credential-leak boundary**: no token/secret value in any thrown error,
  `--debug` output, or stdout — regression tests exist (oauth.test.ts,
  http.test.ts, cli.test.ts); extend them for every new secret-touching path.
- **Config functions, not constants**: `POSTCTL_CONFIG_DIR` is read at call
  time. Test isolation depends on this — never hoist to module scope.
- **No provider imports another provider.** New platform = one file + one
  colocated test + one `docs/platforms/<id>.md` (version.test.ts enforces the doc).
- **No interactive prompts in the write path** — agents can't answer them.
  Missing input = error naming the exact flag/command.
- **Output**: `detectFormat` precedence = flag > agent env > TTY. JSON must
  stay bit-stable for pipes; decoration only on TTY.
- `package.json` is the single version source; `cli.ts` VERSION must match
  (version.test.ts enforces).

## Testing conventions

Tests colocated (`x.ts` → `x.test.ts`). Mock network with
`spyOn(globalThis, "fetch")` — never re-spy in the same test, restore in
`afterEach`. Shared helpers in `src/__fixtures__/test-helpers.ts`
(temp config dir, seeded tokens, temp video files). CLI-level tests spawn the
real binary and assert exit codes + JSON shape.

## Decisions

ADRs in `docs/adr/` (template: `0000-template.md`). Evidence base for the
platform strategy lives in `docs/research/`. Current scope: YouTube shipped
first (ADR-000); Instagram + Facebook Pages next; X, LinkedIn after.
