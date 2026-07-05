# E2E test-session prompt — YouTube provider

Copy-paste the block below into a fresh session to run the real-creds e2e test.
Dev session reads the report this produces at `docs/testing/e2e-youtube-*-report.md`.

---

You are the test operator for postctl (repo: /Users/malhar/swadharma/Code/postctl).
Role: TEST ONLY — do not refactor or fix source code. Every defect goes in the
report, not in a patch. You may fix nothing except the report file itself.

GOAL (timebound: 90 min total): produce a pass/fail report proving postctl's
YouTube provider works end-to-end with real Google credentials, committed as
docs/testing/e2e-youtube-<YYYYMMDD>-report.md.

First read: README.md, docs/platforms/youtube.md, CLAUDE.md. Then execute:

PHASE 1 — GCP setup (~30 min, guide me through browser steps; if a step blocks
me >15 min, record the blocker in the report and stop):
1. Create GCP project, enable YouTube Data API v3.
2. OAuth consent screen: External, scopes youtube.upload + youtube.readonly,
   PUBLISH TO PRODUCTION (Testing mode = refresh tokens die in 7 days — hard fail).
3. Create OAuth client, type "Desktop app". I'll give you client ID + secret
   via env vars YT_CLIENT_ID / YT_CLIENT_SECRET when you ask (never echo them).

PHASE 2 — CLI verification (~40 min). Budget: MAX 2 real uploads (each costs
1,600 of 10,000 daily quota units). Record for every step: command, exit code,
expected vs actual, pass/fail. Steps:
1. Baseline: `bun test` and `bunx tsc --noEmit` both clean.
2. `./bin/postctl --help` → exit 0.
3. `./bin/postctl auth login youtube --account yttest --client-id "$YT_CLIENT_ID" --client-secret "$YT_CLIENT_SECRET"`
   → browser opens, I authorize → exit 0, prints my channel name.
4. `./bin/postctl auth status --output json` → status "ok (auto-refresh)"; no
   token values anywhere in output.
5. `./bin/postctl validate "Title" --output json` (no --media) → exit 1,
   JSON {valid:false, errors mentioning --media}.
6. Generate test video: `ffmpeg -f lavfi -i testsrc=duration=10:size=640x360:rate=25 -f lavfi -i sine=frequency=440:duration=10 -pix_fmt yuv420p /tmp/postctl-test.mp4`
7. `./bin/postctl validate "postctl e2e test" --media /tmp/postctl-test.mp4 --output json` → exit 0.
8. `./bin/postctl post "postctl e2e test" --media /tmp/postctl-test.mp4 --dry-run --output json`
   → exit 0, full payload, zero network calls.
9. REAL UPLOAD 1: `./bin/postctl post "postctl e2e test $(date +%s)" --media /tmp/postctl-test.mp4 --description "automated e2e test, delete me" --tags "test" --output json`
   → exit 0, result has id, url, studioUrl, privacy "private". Verify in
   YouTube Studio: video exists, Private.
10. REAL UPLOAD 2 (unaudited-downgrade check): same but --privacy public →
    expect result carries privacy "private" + a warning field mentioning the
    compliance audit (project is unaudited — downgrade is EXPECTED, not a bug).
    If it actually lands public, record that too (project may be pre-2020-rule
    or already audited).
11. `./bin/postctl auth logout --account yttest` → exit 0; then repeat step 9's
    command → exit 4, stderr names the exact auth login command.
12. Re-login using only `--account yttest` (no client flags) → record actual
    behavior (client_id persists in profile; does it demand --client-secret
    again after logout? whatever happens, document it as UX finding).

PHASE 3 — report (~20 min):
- Write docs/testing/e2e-youtube-<YYYYMMDD>-report.md: env versions (bun,
  macOS), step table (step | command | expected | actual | exit code | P/F),
  bugs/findings with exact error text (REDACT any token/secret/client values),
  quota consumed, and a one-line verdict.
- Commit ONLY the report file (message: "test: e2e YouTube report <date>").
- Remind me to delete the 2 test videos in YouTube Studio (postctl has no
  delete verb yet).

Hard rules: never print or commit secrets; no source edits; stop at 90 min and
report whatever you have; treat "uploads forced Private" as expected behavior.
