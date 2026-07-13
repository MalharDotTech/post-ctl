# Phase 1 — Distribution & Onboarding (v0.3.0)

Goal: someone installs postctl in one command, runs a guided setup for YouTube,
and integrates it into a script/agent without reading source. Ship as npm
package + standalone binaries + docs page.

Read `CLAUDE.md` first. Hard rules that apply to every task here:

- Zero runtime dependencies. Bun built-ins + Web APIs only. (devDependencies
  for build tooling are acceptable; nothing new in `dependencies`.)
- Credential-leak boundary: no token/secret value in errors, `--debug`, stdout.
  Extend regression tests for every new secret-touching path.
- Exit codes: 0 success · 1 validation/API failure · 4 auth required. Only
  `cli.ts` (and `validateCmd`) set `process.exitCode`.
- `POSTCTL_CONFIG_DIR` read at call time, never module scope.
- No interactive prompts in the **write path** (`post`, `validate`, `auth
  login` non-TTY). The setup wizard (T4) is explicitly NOT the write path —
  prompts allowed there, but it must refuse cleanly when stdin is not a TTY.
- `package.json` is the single version source; `cli.ts` VERSION must match
  (version.test.ts enforces). Bump both to `0.3.0` in T7.
- Tests colocated (`x.ts` → `x.test.ts`), network mocked with
  `spyOn(globalThis, "fetch")`, restore in `afterEach`.

Task order: T1 → T2 → T3 can proceed in parallel with T4 → T5. T6 depends on
T1–T5 being real (docs describe what exists). T7 last.

---

## T0 — Branch prep

- Merge `feat/instagram-facebook` into `main` (it is complete and committed).
- Create `feat/distribution` from `main`. All Phase 1 work lands there.

## T1 — Compiled binaries + release pipeline

**What:** `bun build --compile` producing standalone binaries (embedded Bun
runtime — end user needs no Bun/Node).

- Targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
  `bun-linux-arm64`, `bun-windows-x64`.
- Add `scripts/build.ts` (or package.json scripts) that builds all targets
  into `dist/` with names like `postctl-darwin-arm64`.
- GitHub Actions workflow `.github/workflows/release.yml`: on tag push `v*`,
  run `bun test` + `bunx tsc --noEmit`, build matrix, generate SHA256SUMS,
  attach binaries + checksums to a GitHub Release.
- Smoke-test the compiled binary in CI: `./postctl --version`, `./postctl
  providers`, `./postctl validate "x" --provider youtube --media <tmp.mp4>`
  (exit 0). On macOS runner also verify token-store file fallback works with
  `POSTCTL_NO_KEYCHAIN=1`.

**Accept:** tag push produces a GH Release with 5 binaries + checksums; each
binary runs `--version` correctly with no runtime installed.

## T2 — npm package (esbuild/biome pattern)

**What:** `npm i -g postctl` / `npx postctl` / `bunx postctl` all work on any
platform, no postinstall script.

- Main package `postctl`: bin is a small **Node-compatible** JS shim (the shim
  runs under whatever runtime npm uses — it must not use Bun APIs). Shim
  resolves the platform package, spawns the binary, forwards argv/stdio/exit
  code.
- Platform packages `@postctl/darwin-arm64`, `@postctl/darwin-x64`,
  `@postctl/linux-x64`, `@postctl/linux-arm64`, `@postctl/win32-x64` — each
  contains one binary, declared with `os`/`cpu` fields, listed as
  `optionalDependencies` of the main package.
- No `postinstall` script anywhere (security posture; matches esbuild/biome).
- Shim error path: if no platform package resolved, print one clear message
  naming the platform and pointing at the curl installer, exit 1.
- Extend the release workflow: publish platform packages then main package,
  with npm provenance (`--provenance`), all at the same version as the git tag.

**Accept:** `npm i -g postctl && postctl --version` works on macOS arm64 and
Linux x64 (CI verifies both); exit codes pass through (spawn a failing
`postctl validate` and assert exit 1).

## T3 — curl installer

**What:** `curl -fsSL <url>/install.sh | sh` for non-npm users.

- `scripts/install.sh` in repo, POSIX sh: detect OS/arch (`uname`), download
  the matching binary from the latest GitHub Release, verify against
  SHA256SUMS, install to `~/.local/bin` (fall back to `/usr/local/bin` only
  if writable; never sudo inside the script), print PATH hint if needed.
- Unsupported platform → clear error naming supported targets.
- Keep it boring: no version pinning flags beyond `POSTCTL_VERSION` env
  override, no self-update.

**Accept:** script installs a working binary on macOS and Linux (CI job runs
it against the just-published release); checksum mismatch aborts install.

## T4 — `postctl setup` wizard

**What:** `postctl setup youtube` — guided, validating, resumable onboarding.
Modeled on wacli.sh / gogcli.sh feel. This is the highest-leverage task.

- New verb `setup <provider>` routed in `cli.ts`, implemented in
  `src/commands/setup.ts`. Only `youtube` initially; unknown provider → error
  listing supported ones.
- TTY-gated: if stdin is not a TTY, print the manual setup doc path
  (`docs/platforms/youtube.md`) and the exact non-interactive commands
  (`auth login … --client-id … --client-secret …`), exit 1. Agents get the
  non-interactive path, humans get the wizard.
- Steps (source copy from `docs/platforms/youtube.md` and
  `docs/testing/e2e-youtube-20260707-report.md` — the exact clickpath is
  already documented there):
  1. Google Cloud project — print console URL, wait for Enter.
  2. Enable YouTube Data API v3 — print direct URL.
  3. OAuth consent screen — print URL; **hard warning that Testing mode
     refresh tokens die after 7 days; must be In production**.
  4. Create Desktop-type OAuth client — print URL; instruct redirect URI
     `http://localhost:8917` where applicable.
  5. Paste client ID → format-validate (`*.apps.googleusercontent.com`).
  6. Paste client secret → non-empty check. **Read with echo disabled if
     feasible in Bun; never print the value back.**
  7. Run the existing `authLogin` flow (browser OAuth) — reuse
     `src/commands/auth.ts`, do not duplicate.
  8. Show `verify` whoami result (channel name/id).
  9. Offer a `--dry-run` test post command to copy.
- Resumable: derive state from config/token-store (client_id already on
  profile → skip to secret; valid token present → skip to verify). Re-running
  is always safe.
- Structure for testability: pure step logic (validation, state derivation,
  copy strings) separated from prompt I/O so `setup.test.ts` covers it without
  a TTY. Colocated test required.
- Secret handling: client secret goes through the existing token-store path
  only. Extend credential-leak regression tests to cover the wizard.

**Accept:** fresh machine → `postctl setup youtube` → authenticated account,
verified channel, in one sitting; non-TTY invocation exits 1 with actionable
text; `bun test` covers step logic and leak boundary.

## T5 — `postctl doctor`

**What:** offline diagnosis command, human + agent readable.

- New verb `doctor` → `src/commands/doctor.ts`. Offline by default (no
  network). Checks:
  - config dir + profiles.json exist and parse
  - per profile: provider known, token present, refresh_token present (for
    `standard` providers), expiry minutes, storage backend (keychain vs file),
    file-mode 0600 when file-backed
  - staging config completeness if set (staging secret present in token store)
  - version: report current; compare to latest GH release **only** behind
    `--online` flag
- Output through `detectFormat`/`printDocs` (JSON stable for agents, table on
  TTY). Every failing check includes the exact fix command.
- Exit 0 all pass · exit 1 any failure. `process.exitCode` set from `cli.ts`
  contract (follow the `validateCmd` precedent).
- Colocated `doctor.test.ts`: seeded-config scenarios via test-helpers fixtures.

**Accept:** healthy setup → exit 0 with all-ok rows; each broken scenario
(missing token, expired, bad staging) → exit 1 + fix command in output.

## T6 — Docs site

**What:** single-page static site, wacli.sh style. Install command, 3-step
quickstart, integration recipes.

- `site/` directory in repo: one `index.html` (hand-rolled or minimal static
  generator — keep zero-dep spirit; no framework).
- Content sections: hero + install commands (curl / npm / bun) · quickstart
  (`setup youtube` → `post`) · agent/script integration recipes (bash + cron +
  JSON output examples, exit-code table) · link to GitHub + platform docs.
- Deploy: Cloudflare Pages via GH Actions on push to main (or `wrangler pages
  deploy`). Domain wiring is out of scope; Pages default URL is fine for now.
- Host `install.sh` at a stable URL from this site (copy in at build/deploy
  time from `scripts/install.sh`).

**Accept:** live Pages URL; copy-pasting the install command from the page
installs postctl; quickstart commands match actual CLI behavior (no drift —
verify each command against `--help` output).

## T7 — Version bump + docs refresh + ADR

- Bump `package.json` and `cli.ts` VERSION to `0.3.0` (version.test.ts guards).
- README: new install section (curl/npm/bun), setup wizard, doctor, link to
  site.
- Update `--help` text in `cli.ts` with `setup` and `doctor` verbs.
- New ADR `docs/adr/` (use `0000-template.md`): distribution decisions —
  compiled binaries over Node port, esbuild-pattern npm layout, no postinstall,
  wizard TTY-gating rationale. Cite this plan.
- `bun test` + `bunx tsc --noEmit` green.

---

## Out of scope for Phase 1 (do not build)

- `postctl serve` webhook mode (Phase 2)
- URL-download for upload providers (Phase 2)
- Cloudflare Worker deploy (Phase 3)
- Any hosted service, telemetry, auto-update, or new runtime dependency
