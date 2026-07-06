---
adr: "001"
title: "Instagram + Facebook Pages providers, R2 media staging"
date: 2026-07-07
status: accepted
postctl_version: "0.2.0"
tags: [instagram, facebook, meta, staging, r2, auth]
---

# ADR-001: Instagram + Facebook Pages providers, R2 media staging

## Decision

Ship Instagram and Facebook Pages providers on Meta Graph API **v25.0**
(current, Feb 2026), with media staged through a user-owned Cloudflare R2
(or any S3-compatible) bucket via hand-rolled SigV4 presigned URLs — zero
new dependencies. Verified against live Meta docs 2026-07-07.

## Context

Both Meta platforms **pull media from a public HTTPS URL** at publish time
(IG `image_url`/`video_url`, FB photos `url`, FB videos `file_url`) — a local
CLI must stage files somewhere fetchable first. Full evidence:
`docs/research/research-20260703.md` §3, design: `docs/research/design.md`.

## Pinned decisions

### Instagram — "Instagram API with Instagram Login" route

- No Facebook Page link required; account must be Business/Creator.
- OAuth: `www.instagram.com/oauth/authorize` → `api.instagram.com/oauth/access_token`.
  **No PKCE support** — `OAuthSpec.pkce: false`, state param still enforced.
  Scopes: `instagram_business_basic`, `instagram_business_content_publish`.
- `finalizeAuth`: short-lived → long-lived via `graph.instagram.com/access_token`
  (`grant_type=ig_exchange_token`, needs client_secret); captures `user_id`.
- Refresh strategy **`exchange`**: `graph.instagram.com/refresh_access_token`
  (`grant_type=ig_refresh_token`). Token is 60-day sliding; refreshable any
  time after 24h age, **dead once expired** (→ exit 4). http.ts refreshes
  opportunistically when token age > 30 days.
- Publishing: container flow on `graph.instagram.com` (unversioned paths —
  IG-Login docs omit version): `POST /{ig_user_id}/media` (image_url |
  media_type=REELS + video_url) → poll `GET /{container}?fields=status_code`
  until FINISHED (bounded) → `POST /{ig_user_id}/media_publish`.
  Video = Reels; plain feed video is dead platform-wide.
- v1 scope: single image or single video per post. Carousel deferred.

### Facebook Pages

- OAuth dialog `www.facebook.com/v25.0/dialog/oauth` (PKCE on) →
  `graph.facebook.com/v25.0/oauth/access_token`. Dev-mode app, role-holders
  only — no App Review (research §3 "dev-mode loophole").
  Scopes: `pages_manage_posts`, `pages_read_engagement`, `publish_video`.
- `finalizeAuth`: user token → long-lived (`fb_exchange_token`) →
  `GET /me/accounts` → select page (`--page <id|name>`, auto if exactly one)
  → **store the Page access token** as the credential. Page tokens derived
  from long-lived user tokens are effectively non-expiring ⇒ refresh
  strategy **`none`**; if it ever dies, 401 → exit 4 → re-login.
- Posting: text/link `POST /{page}/feed`; images staged → unpublished
  `POST /{page}/photos` (url=staged) → `/feed` with `attached_media`
  (uniform for 1..N images); video `POST /{page}/videos` (file_url=staged).

### Media staging (stage.ts)

- SigV4 **query presign** (UNSIGNED-PAYLOAD, host-only signed header),
  ~130 LOC on `crypto.subtle`. R2 and AWS S3 share the algorithm; R2 =
  path-style endpoint `https://<acct>.r2.cloudflarestorage.com`, region `auto`.
- Global `staging` block in profiles.json (endpoint, bucket, region,
  accessKeyId, prefix, presignTtlSeconds); **secretAccessKey lives in the
  token store** (key `staging/default`), never in config.
- Flow: presigned PUT upload → presigned GET handed to Meta (TTL 1h, bucket
  stays private) → best-effort presigned DELETE after publish; bucket
  lifecycle rule (1 day) documented as the backstop.
- Verbs: `staging set` / `staging status` / `staging test` (round-trip
  PUT+GET+DELETE — works against real R2 or any local S3-compatible server).
- Escape hatch: `--media-url <https://…>` skips staging (asset already hosted).

### Core changes

- `Provider.finalizeAuth?` hook: post-exchange, pre-store transform
  (Meta long-lived exchanges, page selection). YouTube untouched (no hook).
- `OAuthSpec.pkce: boolean` — IG is the first non-PKCE provider.
- http.ts implements `exchange` refresh (was guarded not-implemented).
- `post` core stages local files automatically for `mediaSource: "public-url"`
  providers before invoking the provider.

## Consequences

- ✅ All Big-5 media patterns now exist: direct resumable (YouTube),
  URL-pull + staging (Meta). X/LinkedIn (direct upload) add nothing new.
- ✅ Staging testable offline against an in-process S3 stub; real-R2 e2e via
  `staging test`.
- ⚠️ Staging bucket = new user-supplied dependency for IG/FB media posts
  (FB text-only posts work without it).
- ⚠️ IG 60-day sliding token: an account idle >60d requires re-login
  (platform policy, unfixable). `auth status` shows days-to-expiry.
- ⚠️ Meta dev-mode apps serve role-holders only; public distribution would
  need App Review — out of scope (ADR-000 verdict).
