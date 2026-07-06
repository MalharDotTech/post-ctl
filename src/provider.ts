import type { AuthedFetch } from "./http.ts";
import type { Profile } from "./config.ts";
import type { TokenResponse } from "./oauth.ts";

// Providers contain request-shaping ONLY: endpoints, payload mapping, error
// interpretation. Auth, refresh, retry, storage, and output live in core.
// No provider imports another provider.

export type RefreshStrategy = "none" | "standard" | "exchange" | "reauth";

export interface OAuthSpec {
  kind: "oauth";
  providerId: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  // Instagram Login doesn't support PKCE (state param still enforced);
  // Google and Facebook do.
  pkce: boolean;
  // Google installed-app clients require client_secret at the token endpoint
  // even with PKCE; pure-PKCE providers (X) set this false.
  clientSecretRequired: boolean;
  refresh: RefreshStrategy;
  // refresh="exchange" (Meta): GET url?grant_type=<grantType>&access_token=…
  exchange?: { url: string; grantType: string };
  // Extra query params for the authorization URL (e.g. Google's
  // access_type=offline + prompt=consent to force a refresh_token).
  authExtraParams?: Record<string, string>;
}

export type AuthSpec = OAuthSpec;  // token-kind providers join later (Buffer)

export interface Capabilities {
  text: { maxChars: number; required: boolean };
  images?: { max: number; formats: string[]; maxBytes: number };
  video?: { formats: string[]; maxBytes: number; required?: boolean };
  link?: "inline" | "attachment" | "unsupported";
  mediaSource: "upload" | "public-url";
}

export interface Post {
  text: string;                    // caption text; video title on YouTube
  // Local files carry path; staged/hosted media carry url (core fills url
  // before provider.post for mediaSource:"public-url" providers; --media-url
  // entries arrive url-only).
  media?: { path?: string; url?: string; alt?: string }[];
  link?: string;
  description?: string;            // YouTube description
  tags?: string[];
  privacy?: "public" | "unlisted" | "private";
}

export interface PostResult {
  id: string;
  url?: string;
  [extra: string]: unknown;        // provider-specific additions (studioUrl…)
}

export interface AccountInfo {
  id: string;
  username: string;
  displayName?: string;
}

export interface AuthedCtx {
  fetch: AuthedFetch;              // auth header injected; never raw tokens
  profileName: string;
  profile: Profile;
  debug: boolean;
  pollDelayMs?: number;            // container-status polling interval (tests: 1)
}

// Returned by finalizeAuth — what actually gets stored after login.
export interface FinalizedAuth {
  access_token: string;
  refresh_token?: string;
  expires_at: number;              // Unix ms
  profileExtras?: Partial<Profile>;
}

export interface Provider {
  id: string;
  auth: AuthSpec;
  capabilities: Capabilities;
  // Offline pre-flight — throws ValidationError, never touches network
  validate(post: Post): void;
  post(ctx: AuthedCtx, post: Post): Promise<PostResult>;
  verify(ctx: AuthedCtx): Promise<AccountInfo>;   // auth status / whoami
  // Optional post-exchange step run by 'auth login' before storing tokens:
  // Meta long-lived exchanges, Facebook page-token derivation. Receives the
  // raw code-exchange response; must scrub secrets from any thrown error.
  finalizeAuth?(raw: TokenResponse, opts: {
    clientId: string;
    clientSecret?: string;
    flags: Record<string, string | boolean>;
  }): Promise<FinalizedAuth>;
}

// ── Registry ───────────────────────────────────────────────────────────────────

import { youtube } from "./providers/youtube.ts";
import { instagram } from "./providers/instagram.ts";
import { facebook } from "./providers/facebook.ts";

export const PROVIDERS: Record<string, Provider> = {
  youtube,
  instagram,
  facebook,
};

export function getProvider(id: string): Provider {
  const p = PROVIDERS[id];
  if (!p) {
    throw new Error(
      `Unknown provider '${id}'. Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return p;
}
