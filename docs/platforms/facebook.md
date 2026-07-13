# Facebook Pages — behavior contract & setup

## Non-negotiables

| Fact | Consequence |
|---|---|
| **Pages only** — personal-timeline posting was removed from the API in 2018 | postctl binds each account to one Page at login. No Page = no posting. |
| Media publishes from a **public HTTPS URL** (photos `url`, videos `file_url`) | Local files are staged via your R2/S3 bucket (`postctl staging set`); text/link posts need no staging. |
| Page access token (derived at login) is **effectively non-expiring** | No refresh dance. If it ever dies (password change, revoked), exit 4 → re-login. |
| Dev-mode app serves **role-holders only** | Fine for a team posting to its own Pages; public distribution would need App Review (out of scope). |

Limits: text ≤63,206 chars · ≤10 images/post · 1 video/post (no mixing) ·
link+video cannot combine.

## One-time setup (admin, ~20 min)

1. [developers.facebook.com](https://developers.facebook.com) → Create app →
   type **Business** → add product **Facebook Login**.
2. Facebook Login → Settings → Valid OAuth Redirect URIs: `http://localhost:8917`.
3. Note **App ID** and **App Secret** (App settings → Basic).
4. App stays in **Development mode**: add operators under App roles
   (Developer/Tester). Each operator must hold a role on the app AND a
   Task/role on the target Page.
5. Staging (only needed for photo/video posts): same bucket as Instagram —
   see [instagram.md](instagram.md) step 5.

## Per-operator setup (~2 min)

```sh
postctl auth login facebook --account isha.fb \
  --client-id <APP-ID> --client-secret <APP-SECRET> --page "Isha Foundation"
```

`--page <id|name>` picks the Page when the account manages several (omit if
exactly one). postctl exchanges your login for a long-lived token, derives the
Page token, and stores only that.

## Daily use

```sh
postctl post "Text update" --account isha.fb
postctl post "Check this out" --link https://isha.sadhguru.org --account isha.fb
postctl post "Photo day" --media ./a.jpg --media ./b.jpg --account isha.fb
postctl post "New video" --media ./talk.mp4 --account isha.fb
```

Result JSON: `id` + `url`. Multi-image posts upload unpublished photos then
attach them to one feed post.

## Troubleshooting

- **"No Facebook Pages on this account"** — the logged-in user manages no
  Pages, or the app lacks `pages_read_engagement`. Pages-only is platform
  policy (see table).
- **Exit 4 on posting** — Page token revoked (password change, security
  checkpoint, role removed). Re-run auth login.
- **Photo/video post fails, text works** — staging not configured or bucket
  unreachable: `postctl staging status` / `postctl staging test`.
