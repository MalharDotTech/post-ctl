import { AuthRequiredError, ApiError } from "./errors.ts";
import { refreshAccessToken } from "./oauth.ts";
import { loadToken, saveToken, isTokenExpired, type StoredToken } from "./token-store.ts";
import type { Profile } from "./config.ts";
import type { OAuthSpec } from "./provider.ts";

// wrappedFetch: the only path providers have to the network. It owns
//   - silent lazy refresh (proactive on expiry window, reactive on 401)
//   - bounded retry on 429/5xx (3 attempts, exponential backoff)
//   - the credential-leak boundary: the token lives in this closure; no
//     secret value ever appears in thrown error text (frappe-ctl ADR-020)
// Providers receive this via AuthedCtx and never touch raw tokens.

export type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_RETRIES = 3;

export interface AuthSession {
  fetch: AuthedFetch;
  profileName: string;
  profile: Profile;
}

export function createAuthSession(
  spec: OAuthSpec,
  profileName: string,
  profile: Profile,
  opts: { retryDelayMs?: number } = {},
): AuthSession {
  const key = `${spec.providerId}/${profileName}`;
  let token = loadToken(key);
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  const reauthMsg = () =>
    `Authentication required for '${profileName}'. Run: postctl auth login ${spec.providerId} --account ${profileName}`;

  async function ensureFresh(): Promise<StoredToken> {
    if (!token) throw new AuthRequiredError(reauthMsg());
    if (!isTokenExpired(token)) return token;
    return refresh();
  }

  async function refresh(): Promise<StoredToken> {
    // Only 'standard' (grant_type=refresh_token) is implemented; 'exchange'
    // (Meta long-lived token exchange) lands with the Instagram/Facebook
    // providers — do NOT fall through to the wrong grant type silently.
    if (!token?.refresh_token || spec.refresh !== "standard") {
      throw new AuthRequiredError(`Token expired and not refreshable. ${reauthMsg()}`);
    }
    if (!profile.client_id) throw new AuthRequiredError(reauthMsg());
    let resp;
    try {
      resp = await refreshAccessToken({
        tokenUrl: spec.tokenUrl,
        clientId: profile.client_id,
        clientSecret: token.client_secret,
        refreshToken: token.refresh_token,
      });
    } catch (e) {
      // Refresh failure (revoked consent, expired refresh token) → exit 4.
      // oauth.ts already scrubbed secret values from the message.
      throw new AuthRequiredError(
        `Token refresh failed: ${e instanceof Error ? e.message : String(e)}\n${reauthMsg()}`,
      );
    }
    token = {
      access_token: resp.access_token,
      // Google may omit refresh_token on refresh responses — keep the old one
      refresh_token: resp.refresh_token ?? token.refresh_token,
      expires_at: Date.now() + resp.expires_in * 1000,
      client_secret: token.client_secret,
      obtained_at: Date.now(),
    };
    saveToken(key, token);
    return token;
  }

  const authedFetch: AuthedFetch = async (url, init = {}) => {
    let current = await ensureFresh();
    let refreshedOn401 = false;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${current.access_token}` },
        });
      } catch (e) {
        // Network failure — message may not contain secrets (we never put
        // them in the URL), rethrow as ApiError after retries
        if (attempt < MAX_RETRIES) {
          await Bun.sleep(retryDelayMs * attempt);
          continue;
        }
        throw new ApiError(`Network error: ${e instanceof Error ? e.message : String(e)}`, 0);
      }

      if (res.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        current = await refresh();  // throws AuthRequiredError on failure
        continue;
      }
      if (res.status === 401) {
        throw new AuthRequiredError(reauthMsg());
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after")) || attempt;
        await Bun.sleep(retryDelayMs * retryAfter);
        continue;
      }
      return res;
    }
  };

  return { fetch: authedFetch, profileName, profile };
}

// Read an error body safely for surfacing to the user. Caps length; callers
// pass the result into ApiError. No secrets can appear here because requests
// never carry secrets in URLs or bodies providers construct.
export async function errorBody(res: Response, cap = 600): Promise<string> {
  try {
    const text = await res.text();
    return text.length > cap ? text.slice(0, cap) + "…" : text;
  } catch {
    return "";
  }
}
