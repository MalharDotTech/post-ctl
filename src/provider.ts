import type { AuthedFetch } from "./http.ts";
import type { Profile } from "./config.ts";

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
  // Google installed-app clients require client_secret at the token endpoint
  // even with PKCE; pure-PKCE providers (X) set this false.
  clientSecretRequired: boolean;
  refresh: RefreshStrategy;
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
  text: string;                    // tweet/caption text; video title on YouTube
  media?: { path: string; alt?: string }[];
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
}

export interface Provider {
  id: string;
  auth: AuthSpec;
  capabilities: Capabilities;
  // Offline pre-flight — throws ValidationError, never touches network
  validate(post: Post): void;
  post(ctx: AuthedCtx, post: Post): Promise<PostResult>;
  verify(ctx: AuthedCtx): Promise<AccountInfo>;   // auth status / whoami
}

// ── Registry ───────────────────────────────────────────────────────────────────

import { youtube } from "./providers/youtube.ts";

export const PROVIDERS: Record<string, Provider> = {
  youtube,
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
