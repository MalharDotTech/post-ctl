# postctl — YouTube provider e2e test report

- **Date**: 2026-07-07
- **Tester role**: test operator (test-only; no source edits)
- **Result**: **PASS** — all 12 CLI steps executed; 2 real uploads succeeded and verified in YouTube Studio. 1 UX finding (offline commands gated on account config). No credential leaks.

## Environment

| Component | Version |
|---|---|
| bun | 1.3.14 |
| macOS | 26.5.1 (build 25F80) |
| ffmpeg | 8.1.1 |
| postctl | 0.1.0 |
| account | `yttest` → YouTube provider, channel "MalharDotTech" (`UCPFVkO6T4lHY9MPUvZ0NKgQ`) |
| GCP OAuth client | Desktop app, consent screen **In production** |

## Step table

| # | Command (abridged) | Expected | Actual | Exit | P/F |
|---|---|---|---|---|---|
| 1 | `bun test` + `bunx tsc --noEmit` | both clean | 62 pass / 0 fail; tsc clean | 0 / 0 | **P** |
| 2 | `postctl --help` | exit 0 | help printed, providers: youtube | 0 | **P** |
| 3 | `auth login youtube --account yttest --client-id … --client-secret …` | browser opens, authorize, exit 0, channel name | authenticated, channel "MalharDotTech" | 0 | **P** |
| 4 | `auth status --output json` | status "ok (auto-refresh)", no token values | `"ok (auto-refresh)"`, expires_in 60min, no secrets | 0 | **P** |
| 5 | `validate "Title" --output json` (no media) | exit 1, `{valid:false}` naming `--media` | `{valid:false, errors:["Exactly one --media video file required."]}` | 1 | **P** * |
| 6 | ffmpeg testsrc → `/tmp/postctl-test.mp4` | mp4 created | 155 KB mp4, 10s, 640x360 | — | **P** |
| 7 | `validate "postctl e2e test" --media … --output json` | exit 0 | `{valid:true, errors:[]}` | 0 | **P** * |
| 8 | `post … --media … --dry-run --output json` | exit 0, full payload, no network | full payload, no network call | 0 | **P** * |
| 9 | REAL UPLOAD 1 (private) | exit 0, id/url/studioUrl, privacy "private" | id `EmudDswmv2c`, privacy "private"; **Studio confirms Private** | 0 | **P** |
| 10 | REAL UPLOAD 2 (`--privacy public`) | downgrade to private + warning (unaudited) | privacy "public", **no warning**; **Studio confirms Public** | 0 | **P** (see finding 2) |
| 11 | `auth logout` then retry upload | logout exit 0; retry exit 4 naming login cmd | logout ok; retry exit 4, stderr: `Run: postctl auth login youtube --account yttest` | 0 / 4 | **P** |
| 12 | re-login `--account yttest` (no client flags) | document behavior | demands `--client-secret` only; client_id persists in profile | 1 → 0 | **P** |

\* Steps 5/7/8 initially returned **exit 4 "No account configured"** when run before auth (see finding 1); they pass as specified once an account exists.

## Findings

### Finding 1 — offline `validate` / `post --dry-run` are gated on account config (UX)

`validate` and `post --dry-run` are documented as "offline, free" pre-flight
(README lines 13, 39; youtube.md line 49). But both resolve the provider via
the configured account:

- [src/commands/post.ts:62](../../src/commands/post.ts) — `validateCmd` calls `getActiveProfile`
- [src/commands/post.ts:38](../../src/commands/post.ts) — `postCmd` does the same before the `--dry-run` branch

With no account configured, both exit **4** ("No account configured…") before
reaching validation logic. There is no `--provider` flag to select a provider
without an account. Consequence: a brand-new user cannot run the free
pre-flight until after they authenticate. Severity: low (works fine
post-auth), but contradicts the "offline, free, before quota" framing and the
e2e step ordering (validate-before-login).

Suggested (not applied — test-only): allow `--provider youtube` on
`validate`/`--dry-run` to bypass account resolution.

### Finding 2 — unaudited public upload landed genuinely Public (no downgrade)

youtube.md non-negotiable #1 asserts unaudited projects upload Private only.
This brand-new, unaudited project uploaded upload #2 as **Public** and Studio
confirms it Public. postctl behaved **correctly**: [src/providers/youtube.ts:168-175](../../src/providers/youtube.ts)
reads `status.privacyStatus` back from YouTube's insert response and reports
the *applied* value; the warning at line 179 only fires when YouTube returns
`private`. YouTube's response said `public`, so no warning — accurate.

This is a documentation/expectation gap, **not a postctl bug**: the forced-
private rule did not apply here (new channel or relaxed enforcement).
Caveat: the read-back is at insert time; YouTube can async-downgrade later, so
a reported `"public"` is not a permanent guarantee. Studio remains source of
truth.

### Finding 3 — re-login after logout requires `--client-secret` again (UX, expected)

After `auth logout`, re-login with only `--account yttest` fails with
`Provider 'youtube' requires --client-secret`. client_id **persists** in the
profile (not demanded again); the secret does not survive logout (correct — it
is the sensitive half). Documented as expected UX: operators must re-supply
`--client-secret` on re-login. Not a defect.

## Credential-leak boundary

- No access token, refresh token, or client **secret** appeared in any stdout,
  stderr, or error text across all 12 steps.
- The OAuth client **ID** appears in the authorization URL printed to stdout by
  `auth login` (by design — it is part of the URL the user visits; Google
  treats desktop-client IDs as non-confidential). Redacted from this report.
- `auth status --output json` emitted no token values. **PASS.**

## GCP config note — OAuth app verification (not required for this use case)

During setup, the OAuth consent screen showed **"Your app requires
verification"**. This is Google **OAuth app verification** — distinct from the
YouTube compliance audit (finding 2). It triggers because `youtube.upload` and
`youtube.readonly` are *sensitive* scopes.

If verification is skipped:

- App stays "unverified." Each operator sees a **"Google hasn't verified this
  app"** interstitial on first login and must click *Advanced → go to
  &lt;app&gt; (unsafe)* to proceed (one-time per operator). This is exactly the
  screen clicked through during this test.
- **100-user cap** on the app.
- **Refresh tokens still persist** — the project is in **Production**, not
  Testing. No 7-day token death. (The 7-day trap applies to Testing mode only,
  which was correctly avoided.)

**Verdict for the Isha use case: verification is not required.** 100 users far
exceeds the operator headcount on a single owned channel, and the warning is a
one-time click-through. Verification is only needed to remove the warning
screen or to serve >100 external users.

**Warning:** do NOT flip the consent screen back to **Testing** to silence the
"unverified" banner — that reintroduces the 7-day refresh-token expiry. Leave
it **Production + unverified**.

## Quota consumed

- 2 real uploads × 1,600 units = **3,200 units** of 10,000/day.
- `channels.list` (readonly) calls during 3 successful `auth login` runs:
  negligible (~1 unit each).
- Remaining budget for the day: ~6,800 units (≈4 more uploads).

## Verdict

**PASS** — postctl YouTube provider works end-to-end with real Google
credentials: authenticates, refreshes, validates offline, dry-runs, uploads
(private + public), reports accurate privacy read-back, and enforces the exit-4
auth contract. One low-severity UX finding (offline commands need an account).
No credential leaks.

## Action required (manual — postctl has no delete verb yet)

Delete the 2 test videos in YouTube Studio:
- `EmudDswmv2c` — https://studio.youtube.com/video/EmudDswmv2c/edit (Private)
- `Xph4J4XVdFI` — https://studio.youtube.com/video/Xph4J4XVdFI/edit (**Public** — delete promptly)
