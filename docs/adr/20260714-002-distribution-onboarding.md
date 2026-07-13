---
adr: "002"
title: "Distribution & onboarding — compiled binaries, npm shim layout, setup wizard, doctor"
date: 2026-07-14
status: accepted
postctl_version: "0.3.0"
tags: [distribution, npm, binaries, installer, onboarding, ci]
---

# ADR-002: Distribution & onboarding

## Decision

Ship postctl as **standalone compiled binaries** (`bun build --compile`, embedded
runtime) distributed three ways — a curl installer, an npm package with a
Node-compatible launcher over per-platform binary packages, and a static docs
site — plus two onboarding verbs (`setup`, `doctor`). Plan:
`docs/plans/phase1-distribution.md`.

## Context

v0.2.0 required end users to clone the repo and have Bun installed
(`bin/postctl` was a shell shim calling `bun run src/cli.ts`). The Phase-1 goal
is one-command install and guided first-run for a non-developer, without reading
source. That forces choices on binary format, npm layout, and where interactive
prompts are allowed given the "no prompts in the write path" rule (CLAUDE.md).

## Pinned decisions

### Compiled binaries over a Node port

- `scripts/build.ts` cross-compiles 5 targets (`darwin-arm64/x64`,
  `linux-x64/arm64`, `windows-x64`) → `dist/postctl-<os>-<arch>`. Bun's
  `--compile --target=` needs no per-platform toolchain. ~61 MB each (embedded
  runtime) — acceptable for a CLI; keeps the zero-runtime-dependency rule intact
  for the end user (no Bun/Node install).
- Rejected: porting core off Bun built-ins to run on Node. Would trade the
  zero-dep rule and Bun-specific code (`Bun.spawnSync` keychain, `Bun.serve`
  loopback) for portability the compiled binary already gives.

### npm layout: launcher + optional platform packages (esbuild/biome pattern)

- Main package `postctl` (unscoped — memorable install, name grabbed) ships one
  **CJS Node launcher** (`bin/postctl.js`, no Bun APIs) that resolves
  `@post-ctl/<platform>` via `require.resolve` and re-execs the binary,
  forwarding argv/stdio/exit code.
- Platform packages `@post-ctl/<platform>` declare `os`/`cpu`, carry one binary,
  and declare **no `bin` field** (would clash with the launcher symlink). They
  are `optionalDependencies` of the main package — npm installs only the match.
  Scope is a **product-scope org** (`@post-ctl`, esbuild pattern). The scope is
  invisible to users (never typed), so this is an operational choice, not a
  branding one.
- **No `postinstall` anywhere** (supply-chain posture; matches esbuild/biome).
- `scripts/npm-pack.ts` assembles `dist/npm/` from compiled binaries, stamping
  every version from `package.json` (the single version source).
- The source repo `package.json` is marked **`private: true`** — publishing
  happens only from `dist/npm`, never the repo tree.

### curl installer (`scripts/install.sh`)

- POSIX sh, `uname` detect, downloads the matching Release asset, **mandatory**
  SHA-256 verify against `SHA256SUMS`, installs to `~/.local/bin`
  (`/usr/local/bin` only if writable, **never sudo**). `POSTCTL_VERSION` pins a
  tag; no other flags, no self-update. Canonical URL is the raw GitHub path
  (`raw.githubusercontent.com/.../scripts/install.sh`) so it works the moment
  the repo is public, independent of any domain wiring.

### Onboarding verbs

- `setup <provider>` — TTY-gated interactive wizard. This is explicitly **not
  the write path**; prompts are allowed, but it refuses cleanly (exit 1, manual
  non-interactive commands) when stdin is not a TTY, so agents get the scriptable
  path and humans get the wizard. Step logic (validation, resumable state
  derivation, copy) is pure and unit-tested; only prompt I/O touches the
  terminal. Client secret is read with terminal echo disabled and flows only
  through the existing token-store path.
- `doctor` — offline diagnosis (config/tokens/staging), `--online` for the
  version check. Exit 1 on any failing check, each row carrying the exact fix
  command. Sets `process.exitCode` itself (the `validateCmd` precedent; CLAUDE.md
  updated to name `doctorCmd`).

### Release pipeline

- `.github/workflows/release.yml`: tag `v*` → test + tsc + tag/version guard →
  build matrix → `SHA256SUMS` → GitHub Release → npm publish (platform packages
  first, then main, `--provenance`) → install.sh smoke on linux + macOS.
- `.github/workflows/pages.yml`: Cloudflare Pages deploy of `site/` on push to
  main, gated on `CLOUDFLARE_ENABLED`. Domain wiring out of scope.

## Consequences

- ✅ `curl … | sh`, `npm i -g postctl`, `npx/bunx postctl` all work with no
  runtime installed; end users never see Bun.
- ✅ Build + installer logic verified locally (compiled binary runs; installer
  happy-path + checksum-mismatch abort proven); npm launcher verified against a
  simulated install layout under Node.
- ⚠️ Live distribution requires operator setup the tooling cannot self-provision:
  repo **public** (unauthenticated Release download, npm provenance OIDC, free
  CI), the **@post-ctl** npm org + `NPM_TOKEN`, and Cloudflare secrets. Until
  then the publish/deploy jobs are dormant.
- ⚠️ Binary size (~61 MB) and 5 platform packages per release are the cost of an
  embedded runtime; the alternative (require Node/Bun) was rejected above.
- ⚠️ Version now lives in three files kept in sync by `version.test.ts`:
  `package.json` (source of truth), `src/version.ts` (internal, imported by
  cli.ts + doctor.ts), and each generated npm `package.json`.
