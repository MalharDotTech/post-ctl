# Instagram — behavior contract & setup

Uses the "Instagram API with Instagram Login" — no Facebook Page link needed.
Platform policy, not postctl limitations:

## Non-negotiables

| Fact | Consequence |
|---|---|
| Account must be **Business or Creator** | Switch in Instagram app: Settings → Account type. Personal accounts cannot use the API. |
| **Media required** — no text-only posts | `postctl validate` enforces. 1 media = single post (video → Reel); 2–10 media = carousel (images and/or videos mixable). |
| **Instagram music library is NOT reachable via API** — app-only feature, no parameter exists | Custom audio must be baked into the video file before posting (subject to IG copyright detection). Reels keep their embedded audio. |
| Instagram **pulls media from a public HTTPS URL** at publish time | postctl stages local files through your R2/S3 bucket automatically — `postctl staging set` is a prerequisite for `--media`. Already-hosted assets: `--media-url <https://…>`. |
| Video = **Reels** (MP4 H.264/AAC, 9:16 recommended); images 4:5–1.91:1 aspect | Container errors name these causes. |
| Token is **60-day sliding**: refreshable after 24h age, dead once expired | postctl auto-refreshes on any use past 30d age ⇒ an account used at least once every 60 days never re-logs. Idle >60d ⇒ exit 4, re-login. |
| ~**50 API posts per 24h** per account | Platform cap. |
| Caption ≤2,200 chars; links in captions are not clickable | Use the bio link. |

## One-time setup (admin, ~20 min)

1. [developers.facebook.com](https://developers.facebook.com) → Create app →
   type **Business** → add product **Instagram** → "API setup with Instagram
   Business Login".
2. In the Instagram product settings, add redirect URI exactly:
   `http://localhost:8917`
3. Note the **Instagram App ID** and **Instagram App Secret** (Instagram
   product page — not the Meta app ID).
4. App can stay in **Development mode**: add each operator's Instagram
   account under Roles → Instagram Testers (accept the invite in the
   Instagram app: Settings → Apps and websites → Tester invites). No App
   Review needed for role-holders (dev-mode loophole).
5. Configure staging once per machine (media publishes from a URL):
   ```sh
   postctl staging set --endpoint https://<acct>.r2.cloudflarestorage.com \
     --bucket postctl-staging --region auto \
     --access-key-id <R2-key-id> --secret-access-key <R2-secret>
   postctl staging test   # round-trip proof
   ```
   Recommended: 1-day expiry lifecycle rule on the bucket (cleanup backstop).

## Per-operator setup (~2 min)

```sh
postctl auth login instagram --account isha.ig \
  --client-id <IG-APP-ID> --client-secret <IG-APP-SECRET>
```

Browser opens → log into the Business/Creator account → done.

## Daily use

```sh
postctl validate "Caption text" --media ./photo.jpg --account isha.ig
postctl post "Caption text" --media ./photo.jpg --account isha.ig
postctl post "Reel caption" --media ./clip.mp4 --account isha.ig   # published as Reel
postctl post "Carousel" --media ./a.jpg --media ./b.jpg --media ./c.mp4 --account isha.ig  # 2-10 items
postctl post "Caption" --media-url https://cdn.example.com/photo.jpg --account isha.ig  # skip staging
```

Result JSON: `id` + `url` (permalink). Reels poll container status until
processed (bounded); exit 1 with the cause on codec/aspect failures.

## Troubleshooting

- **`Media container ERROR`** — staging URL expired (TTL), wrong codec
  (Reels want MP4 H.264/AAC), or image aspect outside 4:5–1.91:1.
- **Exit 4 "Token expired (Meta tokens cannot be refreshed once expired)"** —
  account idle >60 days. Re-run auth login.
- **Login fails for the account** — account isn't Business/Creator, or isn't
  added as Instagram Tester on the dev-mode app.
