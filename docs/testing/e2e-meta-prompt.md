# E2E test-session prompt — Instagram + Facebook providers

Copy-paste the block below into a fresh session. Dev session reads the report
at `docs/testing/e2e-meta-*-report.md`. Prereqs you bring: an Instagram
**Business/Creator** account, a Facebook account managing at least one Page,
a Cloudflare account (free R2 tier is enough).

---

You are the test operator for postctl (repo: /Users/malhar/swadharma/Code/postctl,
branch **feat/instagram-facebook** — check it out first; do NOT touch main).
Role: TEST ONLY — no source edits; every defect goes in the report.

GOAL (timebound: 2h30m total): produce a pass/fail report proving postctl's
Instagram + Facebook providers and R2 staging work end-to-end with real
credentials, committed to the feature branch as
docs/testing/e2e-meta-<YYYYMMDD>-report.md.

First read: README.md, docs/platforms/instagram.md, docs/platforms/facebook.md,
CLAUDE.md. Then execute:

PHASE 1 — R2 staging (~20 min):
1. Guide me: Cloudflare dashboard → R2 → create bucket `postctl-staging`
   (add 1-day object-lifecycle expiry rule) → create R2 API token
   (Object Read & Write, this bucket only). I'll set env R2_ENDPOINT,
   R2_KEY_ID, R2_SECRET when you ask (never echo them).
2. `postctl staging set --endpoint "$R2_ENDPOINT" --bucket postctl-staging
   --region auto --access-key-id "$R2_KEY_ID" --secret-access-key "$R2_SECRET"`
   → exit 0.
3. `postctl staging status --output json` → secret "stored", no secret value in output.
4. `postctl staging test --output json` → staging_test "pass". This proves
   SigV4 against real R2.

PHASE 2 — Meta app setup (~40 min, guide me through browser; if blocked
>20 min on a step, record blocker and continue with the other provider):
1. developers.facebook.com → Create app (type Business).
2. Instagram: add product "Instagram" → API setup with Instagram Business
   Login → redirect URI http://localhost:8917 → note Instagram App ID/Secret
   (env IG_CLIENT_ID / IG_CLIENT_SECRET). Add my IG account under
   Instagram Testers; I accept the invite in the IG app.
3. Facebook: add product "Facebook Login" → Valid OAuth Redirect URIs
   http://localhost:8917 → note App ID/Secret (env FB_CLIENT_ID /
   FB_CLIENT_SECRET). My account already holds a role (I created the app).
   App stays in Development mode throughout.

PHASE 3 — CLI verification (~60 min). Record per step: command, exit code,
expected vs actual, P/F. Generate assets once:
  - photo: `ffmpeg -f lavfi -i testsrc=duration=1:size=1080x1350:rate=1 -frames:v 1 /tmp/pctl-a.jpg` (4:5)
  - photo2: same → /tmp/pctl-b.jpg with color=blue source
  - video: `ffmpeg -f lavfi -i testsrc=duration=8:size=1080x1920:rate=30 -f lavfi -i sine=frequency=440:duration=8 -c:v libx264 -pix_fmt yuv420p -c:a aac /tmp/pctl-v.mp4` (9:16 Reel-ready)

Steps:
1. Baseline on branch: `bun test` (99 pass) + `bunx tsc --noEmit` clean.
2. `postctl auth login instagram --account ig.test --client-id "$IG_CLIENT_ID" --client-secret "$IG_CLIENT_SECRET"`
   → browser → log into IG Business account → exit 0, prints username.
3. `postctl auth login facebook --account fb.test --client-id "$FB_CLIENT_ID" --client-secret "$FB_CLIENT_SECRET"`
   → if multiple pages, expect exit 1 listing pages, then retry with
   --page <name> → exit 0, prints page name. Record both behaviors.
4. `postctl auth status --output json` → both accounts listed; IG shows
   auto-refresh semantics; NO token/secret values anywhere.
5. `postctl validate "cap" --account ig.test --output json` (no media) →
   exit 1, error says media required.
6. IG image: `postctl post "postctl e2e image $(date +%s)" --media /tmp/pctl-a.jpg --account ig.test --output json`
   → exit 0, id + permalink url. Verify post visible on the IG profile.
7. IG Reel: same with /tmp/pctl-v.mp4 → exit 0. Expect container polling
   (takes ~30-90s). Verify it landed as a Reel with its baked-in audio.
8. IG CAROUSEL: `postctl post "postctl e2e carousel $(date +%s)" --media /tmp/pctl-a.jpg --media /tmp/pctl-b.jpg --media /tmp/pctl-v.mp4 --account ig.test --output json`
   → exit 0. Verify: swipeable 3-item carousel on the profile, caption on
   the whole carousel, video item plays. NOTE (expected, not a bug):
   Instagram music-library audio cannot be attached via API — app-only.
   Confirm the carousel video kept its embedded sine-tone audio.
9. FB text: `postctl post "postctl e2e text $(date +%s)" --account fb.test --output json` → exit 0, id + url. Verify on the Page.
10. FB link: same + `--link https://example.com` → exit 0, link preview on the Page post.
11. FB multi-image: `--media /tmp/pctl-a.jpg --media /tmp/pctl-b.jpg` →
    exit 0, ONE post with both photos attached.
12. FB video: `--media /tmp/pctl-v.mp4` → exit 0. Verify video plays on the Page
    (FB may take a minute to process).
13. R2 cleanup check: after steps 6-12, Cloudflare dashboard → bucket should
    contain 0 objects under postctl/ (auto-delete after publish). Record count.
14. `postctl auth logout --account ig.test` → exit 0; retry step 6 → exit 4
    naming the login command.
15. `postctl post "x" --account ig.test --media /tmp/pctl-a.jpg --dry-run --output json`
    (while logged out) → exit 0, payload printed, nothing staged to R2.

Budget: ≤6 IG posts (cap is ~50/day — fine) and ≤5 FB posts. All posts are
public — use throwaway captions; we delete after.

PHASE 4 — report (~20 min):
- Write docs/testing/e2e-meta-<YYYYMMDD>-report.md: env versions, step table
  (step | command | expected | actual | exit | P/F), findings with exact
  error text (REDACT tokens/secrets/app ids), R2 object-count observation,
  carousel + audio observations, one-line verdict.
- Commit ONLY the report to feat/instagram-facebook
  (message: "test: e2e Meta report <date>") and push.
- Remind me to delete the test posts (IG profile + FB Page) manually —
  postctl has no delete verb.

Hard rules: never print or commit secrets; no source edits; branch
feat/instagram-facebook only; stop at 2h30m and report whatever you have.
