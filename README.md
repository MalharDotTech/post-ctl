# postctl

The missing CLI for social posting. One grammar for YouTube, Instagram,
Facebook, X, and LinkedIn — built for humans, scripts, CI, and AI agents.

**Status: v0.1.0 — YouTube provider shipped. Instagram/Facebook next.**

```sh
# Authenticate once (browser OAuth, tokens in your keychain)
postctl auth login youtube --account isha --client-id <ID> --client-secret <SECRET>

# Pre-flight offline — no quota spent
postctl validate "Video title" --media ./talk.mp4

# Upload
postctl post "Video title" --media ./talk.mp4 --description ./desc.txt --tags "a,b"

# Same command, JSON out, when piped or run by an agent
postctl post "Video title" --media ./talk.mp4 | jq .url
```

## Why a CLI, not a SaaS

Your accounts, your API apps, your tokens — in your keychain, on your machine.
No subscription, no third party holding write access to your channels.
Scheduling belongs to `cron`/CI/your agent; postctl does one thing per invocation
and exits with a code you can branch on.

## Design

- **Exit codes**: `0` success · `1` validation/API failure · `4` auth required
  (expired non-refreshable token — the message names the exact command to fix it).
- **Output**: tables on a TTY, bit-stable JSON when piped or invoked by an
  AI agent (detected via env). Override with `--output json|table`.
- **Auth**: OAuth 2.0 + PKCE, loopback redirect, silent auto-refresh.
  Tokens in macOS Keychain (file fallback `0o600`). No secret ever appears
  in output or error text — enforced by regression tests.
- **Zero dependencies**: Bun + TypeScript, nothing else. No daemon, no database.
- **`--dry-run`** prints the exact payload without touching the network.

## Verbs

| Verb | Purpose |
|---|---|
| `auth login <provider>` | Browser OAuth flow, stores tokens |
| `auth status` | Per-account expiry dashboard (offline) |
| `auth logout` | Delete stored token |
| `accounts list\|use\|remove` | Manage named accounts |
| `post "<text>"` | Publish (`--media`, `--description`, `--tags`, `--privacy`, `--dry-run`) |
| `validate "<text>"` | Offline pre-flight, exit 1 + structured errors on fail |
| `providers` | List available providers |

## Platforms

| Provider | Status | Behavior contract |
|---|---|---|
| YouTube | ✅ shipped | [docs/platforms/youtube.md](docs/platforms/youtube.md) — read this first; quota + audit rules |
| Instagram | planned | needs media staging (S3/R2) |
| Facebook Pages | planned | pages only (API policy) |
| X | planned | pay-per-use API pricing |
| LinkedIn | planned | 60-day re-auth wall (API policy) |

Platform setup (developer app, one-time, ~30 min) is documented per provider
in `docs/platforms/`. Research and architecture decisions in `docs/research/`
and `docs/adr/`.

## Install (dev)

```sh
git clone https://github.com/MalharDotTech/postctl && cd postctl
bun install && bun test
./bin/postctl --help
```

## License

MIT
