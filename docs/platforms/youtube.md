# YouTube — behavior contract & setup

What you must know before automating YouTube uploads with postctl. Read all of
"Non-negotiables" — none of them are postctl limitations; they are platform policy.

## Non-negotiables

| Fact | Consequence |
|---|---|
| Unaudited API projects **may** have uploads forced Private (Google's published rule since Jul 2020; enforcement observed inconsistent — a fresh unaudited project uploaded Public successfully in our 2026-07 e2e test) | postctl reports the **applied** privacy in result JSON and adds a `warning` field when YouTube downgrades your request. Studio is the source of truth — YouTube can also downgrade asynchronously after upload. If downgrades hit you, apply for the [compliance audit](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits). |
| Quota: 10,000 units/day per GCP project; one upload = 1,600 units | **~6 uploads/day.** Request a quota increase on the audited project if volume demands. |
| OAuth consent screen in **Testing** mode ⇒ refresh tokens die after 7 days | Consent screen MUST be published to **Production** before the team logs in. |
| Title ≤100 chars, description ≤5,000 bytes, no `<` or `>` in either | `postctl validate` enforces offline, before quota spend. |

## One-time setup (admin, ~30 min)

1. [console.cloud.google.com](https://console.cloud.google.com) → create project (e.g. `isha-postctl`).
2. APIs & Services → Library → enable **YouTube Data API v3**.
3. APIs & Services → OAuth consent screen:
   - User type **External**, fill app name/support email.
   - Scopes: `youtube.upload`, `youtube.readonly`.
   - **Publish to Production** (do NOT stay in Testing — see table above).
   - The console will warn **"Your app requires verification"** (upload/readonly
     are sensitive scopes). **Skipping verification is fine for team use**: each
     operator clicks through a one-time "Google hasn't verified this app" →
     Advanced → continue screen, and the app is capped at 100 users — far above
     a team's headcount. Verify only to remove that screen. Never revert to
     Testing to silence the banner — that reintroduces 7-day token death.
4. Credentials → Create credentials → OAuth client ID → type **Desktop app**.
   - Note the client ID and client secret. Google treats desktop-app secrets
     as non-confidential, but postctl still stores the secret in the keychain.
5. Redirect URI `http://localhost:8917` — Google desktop clients accept any
   localhost port automatically; nothing to register.
6. Share client ID + secret with each operator (password manager, not chat).
7. Only if public uploads get downgraded to Private (check the `warning` field
   on results): submit the compliance-audit questionnaire.

## Per-operator setup (~2 min)

Each team member, on their own machine:

```sh
postctl auth login youtube --account isha \
  --client-id <ID> --client-secret <SECRET>
```

Browser opens → pick the Google account that has access to the channel
(**for Brand Accounts: pick the brand account at the chooser, not your
personal account**) → done. Tokens live in the operator's own keychain and
refresh silently forever. Re-login is only needed if consent is revoked.

## Daily use

```sh
# Pre-flight (offline, free; --provider youtube lets it run before auth login)
postctl validate "Video title" --media ./talk.mp4 --account isha

# Upload (private by default; result includes Studio link for publish)
postctl post "Video title" --media ./talk.mp4 \
  --description ./description.txt --tags "sadhguru,wisdom" --account isha

# Public upload (result carries a `warning` field if YouTube downgrades to private)
postctl post "Video title" --media ./talk.mp4 --privacy public --account isha

# Token dashboard
postctl auth status
```

`--description` accepts a literal string or a path to a text file.
Result JSON always includes `url` (watch page), `studioUrl` (edit/publish), and
`privacy` — the value YouTube actually applied at insert time, which may differ
from what you requested (see Non-negotiables).

## Troubleshooting

- **`auth login` fails with "No refresh_token in response"** — consent screen
  is in Testing, or this Google account previously granted the app. Publish
  consent screen to Production, revoke access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions), retry.
- **`quotaExceeded` (403)** — daily 10k units exhausted (~6 uploads). Resets
  midnight Pacific. Request increase if recurring.
- **"No YouTube channel on this Google account"** — the channel is on a Brand
  Account; re-run `auth login` and pick the brand account at Google's chooser.
- **Re-login demands `--client-secret` again** — expected. `auth logout`
  deletes the stored secret with the token (it's the sensitive half);
  `--client-id` persists in the profile and isn't asked again.
- **Upload stuck/interrupted** — postctl resumes automatically (5 attempts).
  Exit 1 after that; re-running re-uploads from scratch (a new session).
