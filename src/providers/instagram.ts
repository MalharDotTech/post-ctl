import { extname } from "path";
import { ValidationError, ApiError, AuthRequiredError } from "../errors.ts";
import { errorBody } from "../http.ts";
import type { Provider, Post, PostResult, AuthedCtx, AccountInfo, FinalizedAuth } from "../provider.ts";
import type { TokenResponse } from "../oauth.ts";

// Instagram via "Instagram API with Instagram Login" — no Facebook Page link
// needed; account must be Business/Creator. Publishing is the container flow:
// create container (IG pulls media from a public URL — core stages local
// files to R2 first) → poll status_code → media_publish. Video = Reels
// (plain feed video is dead platform-wide). Long-lived token is 60-day
// sliding: http.ts refreshes via ig_refresh_token when age >30d; an expired
// token cannot be refreshed (exit 4). IG-Login endpoints live on
// graph.instagram.com, unversioned. ~50 posts/24h platform cap.

const IG_GRAPH = "https://graph.instagram.com";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png"];
const VIDEO_EXTS = [".mp4", ".mov"];
const MAX_CAPTION_CHARS = 2200;
const MAX_POLL_ATTEMPTS = 40;   // video processing can take a while

function mediaExt(m: { path?: string; url?: string }): string {
  if (m.path) return extname(m.path).toLowerCase();
  if (m.url) return extname(new URL(m.url).pathname).toLowerCase();
  return "";
}
const isVideo = (m: { path?: string; url?: string }) => VIDEO_EXTS.includes(mediaExt(m));
const isImage = (m: { path?: string; url?: string }) => IMAGE_EXTS.includes(mediaExt(m));

function validate(post: Post): void {
  const errors: string[] = [];
  const media = post.media ?? [];

  if (media.length !== 1) {
    errors.push("Instagram requires exactly one --media (image or video) — text-only posts don't exist. Carousels: not yet supported.");
  } else {
    const m = media[0]!;
    if (!isVideo(m) && !isImage(m)) {
      errors.push(`Unsupported media format '${mediaExt(m)}'. Images: ${IMAGE_EXTS.join(" ")} · Video (Reels): ${VIDEO_EXTS.join(" ")}`);
    }
  }
  if (post.text.length > MAX_CAPTION_CHARS) {
    errors.push(`Caption too long: ${post.text.length} chars (max ${MAX_CAPTION_CHARS}).`);
  }
  if (post.link) {
    errors.push("Instagram has no link attachment — links in captions are not clickable; use the bio link.");
  }

  if (errors.length) throw new ValidationError(errors.join("\n"));
}

function igUserId(ctx: AuthedCtx): string {
  const id = ctx.profile.ig_user_id;
  if (!id) {
    throw new AuthRequiredError(
      `No Instagram user bound to '${ctx.profileName}'. Run: postctl auth login instagram --account ${ctx.profileName}`,
    );
  }
  return id;
}

async function post(ctx: AuthedCtx, p: Post): Promise<PostResult> {
  validate(p);
  const user = igUserId(ctx);
  const m = p.media![0]!;
  if (!m.url) throw new ValidationError("Media has no staged URL — staging must run before publish.");

  // 1. Create container
  const params = new URLSearchParams({ caption: p.text });
  if (isVideo(m)) {
    params.set("media_type", "REELS");
    params.set("video_url", m.url);
  } else {
    params.set("image_url", m.url);
  }
  const createRes = await ctx.fetch(`${IG_GRAPH}/${user}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!createRes.ok) {
    throw new ApiError(`Container create failed (${createRes.status}): ${await errorBody(createRes)}`, createRes.status);
  }
  const container = (await createRes.json() as { id: string }).id;

  // 2. Poll until FINISHED (bounded) — images are usually instant, Reels
  // take processing time
  const delay = ctx.pollDelayMs ?? 5000;
  let status = "IN_PROGRESS";
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const res = await ctx.fetch(`${IG_GRAPH}/${container}?fields=status_code`);
    if (!res.ok) {
      throw new ApiError(`Container status check failed (${res.status}): ${await errorBody(res)}`, res.status);
    }
    status = (await res.json() as { status_code?: string }).status_code ?? "IN_PROGRESS";
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ApiError(
        `Media container ${status} — Instagram could not fetch/process the media. Common causes: staging URL expired (TTL), unsupported codec (Reels want MP4 H.264/AAC, 9:16), image aspect ratio outside 4:5–1.91:1.`,
        422,
      );
    }
    if (ctx.debug) console.error(`[debug] instagram container ${container}: ${status} (${i + 1}/${MAX_POLL_ATTEMPTS})`);
    await Bun.sleep(delay);
  }
  if (status !== "FINISHED") {
    throw new ApiError(`Media container still ${status} after ${MAX_POLL_ATTEMPTS} checks — try again; the container may finish and remain publishable for 24h.`, 408);
  }

  // 3. Publish
  const pubRes = await ctx.fetch(`${IG_GRAPH}/${user}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: container }).toString(),
  });
  if (!pubRes.ok) {
    throw new ApiError(`Publish failed (${pubRes.status}): ${await errorBody(pubRes)}`, pubRes.status);
  }
  const mediaId = (await pubRes.json() as { id: string }).id;

  // 4. Permalink (best-effort — publish already succeeded)
  let url: string | undefined;
  const linkRes = await ctx.fetch(`${IG_GRAPH}/${mediaId}?fields=permalink`);
  if (linkRes.ok) {
    url = (await linkRes.json() as { permalink?: string }).permalink;
  }
  return { id: mediaId, url };
}

async function verify(ctx: AuthedCtx): Promise<AccountInfo> {
  const res = await ctx.fetch(`${IG_GRAPH}/me?fields=user_id,username`);
  if (!res.ok) {
    throw new ApiError(`Account lookup failed (${res.status}): ${await errorBody(res)}`, res.status);
  }
  const data = await res.json() as { user_id?: string | number; id?: string; username: string };
  return { id: String(data.user_id ?? data.id ?? ""), username: data.username, displayName: data.username };
}

// short-lived → long-lived (60d sliding); captures ig user id
async function finalizeAuth(
  raw: TokenResponse,
  opts: { clientId: string; clientSecret?: string; flags: Record<string, string | boolean> },
): Promise<FinalizedAuth> {
  const res = await fetch(`${IG_GRAPH}/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: opts.clientSecret ?? "",
    access_token: raw.access_token,
  })}`);
  if (!res.ok) {
    // URL carries secret + token — surface status only
    throw new AuthRequiredError(`Long-lived token exchange failed (${res.status}). Check the app secret and that the account is Business/Creator.`);
  }
  const ll = await res.json() as { access_token: string; expires_in?: number };
  return {
    access_token: ll.access_token,
    expires_at: Date.now() + (ll.expires_in ?? 5_184_000) * 1000,
    profileExtras: raw["user_id"] !== undefined ? { ig_user_id: String(raw["user_id"]) } : undefined,
  };
}

export const instagram: Provider = {
  id: "instagram",
  auth: {
    kind: "oauth",
    providerId: "instagram",
    authUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    pkce: false,   // IG Login doesn't support PKCE; state is still enforced
    clientSecretRequired: true,
    refresh: "exchange",
    exchange: { url: `${IG_GRAPH}/refresh_access_token`, grantType: "ig_refresh_token" },
  },
  capabilities: {
    text: { maxChars: MAX_CAPTION_CHARS, required: false },
    images: { max: 1, formats: IMAGE_EXTS, maxBytes: 8 * 1024 ** 2 },
    video: { formats: VIDEO_EXTS, maxBytes: 1024 ** 3 },
    link: "unsupported",
    mediaSource: "public-url",
  },
  validate,
  post,
  verify,
  finalizeAuth,
};
