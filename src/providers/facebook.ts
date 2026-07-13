import { extname } from "path";
import { ValidationError, ApiError, AuthRequiredError } from "../errors.ts";
import { errorBody } from "../http.ts";
import type { Provider, Post, PostResult, AuthedCtx, AccountInfo, FinalizedAuth } from "../provider.ts";
import type { TokenResponse } from "../oauth.ts";

// Facebook Pages via Graph API v25.0. Personal timelines are API-dead since
// 2018 (platform policy) — Pages only. The stored credential is the PAGE
// access token, derived at login: user token → long-lived (fb_exchange_token)
// → /me/accounts → page token. Page tokens from long-lived user tokens are
// effectively non-expiring ⇒ refresh strategy "none"; death → exit 4 → re-login.
// Photos/videos publish from a public URL (url / file_url) — core stages
// local files to R2 first (mediaSource: "public-url").

const V = "v25.0";
const GRAPH = `https://graph.facebook.com/${V}`;

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const VIDEO_EXTS = [".mp4", ".mov"];
const MAX_TEXT_CHARS = 63_206;
const MAX_IMAGES = 10;
// Page tokens don't expire; give the store a far-future timestamp
const PAGE_TOKEN_LIFETIME_MS = 10 * 365 * 24 * 3600_000;

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

  if (!post.text?.trim() && media.length === 0) {
    errors.push("Facebook post needs text or --media.");
  }
  if (post.text.length > MAX_TEXT_CHARS) {
    errors.push(`Text too long: ${post.text.length} chars (max ${MAX_TEXT_CHARS}).`);
  }
  const videos = media.filter(isVideo);
  const images = media.filter(isImage);
  const unknown = media.filter((m) => !isVideo(m) && !isImage(m));
  if (unknown.length) {
    errors.push(`Unsupported media format(s): ${unknown.map(mediaExt).join(" ")}. Images: ${IMAGE_EXTS.join(" ")} · Video: ${VIDEO_EXTS.join(" ")}`);
  }
  if (videos.length > 1) errors.push("At most one video per post.");
  if (videos.length && images.length) errors.push("Cannot mix video and images in one post.");
  if (images.length > MAX_IMAGES) errors.push(`Max ${MAX_IMAGES} images per post.`);
  if (videos.length && post.link) errors.push("Link and video cannot be combined — put the URL in the text.");

  if (errors.length) throw new ValidationError(errors.join("\n"));
}

function pageId(ctx: AuthedCtx): string {
  const id = ctx.profile.page_id;
  if (!id) {
    throw new AuthRequiredError(
      `No Facebook Page bound to '${ctx.profileName}'. Run: postctl auth login facebook --account ${ctx.profileName}`,
    );
  }
  return id;
}

async function graphError(res: Response, what: string): Promise<never> {
  throw new ApiError(`${what} failed (${res.status}): ${await errorBody(res)}`, res.status);
}

async function post(ctx: AuthedCtx, p: Post): Promise<PostResult> {
  validate(p);
  const page = pageId(ctx);
  const media = p.media ?? [];
  const video = media.find(isVideo);
  const images = media.filter(isImage);

  // Video → /videos with file_url (staged/hosted URL)
  if (video) {
    if (!video.url) throw new ValidationError("Video has no staged URL — staging must run before publish.");
    const res = await ctx.fetch(`${GRAPH}/${page}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ file_url: video.url, description: p.text }).toString(),
    });
    if (!res.ok) await graphError(res, "Video post");
    const data = await res.json() as { id: string };
    return { id: data.id, url: `https://www.facebook.com/${page}/videos/${data.id}` };
  }

  // Images → unpublished /photos each, then /feed with attached_media
  // (uniform for 1..N)
  const attached: string[] = [];
  for (const img of images) {
    if (!img.url) throw new ValidationError("Image has no staged URL — staging must run before publish.");
    const res = await ctx.fetch(`${GRAPH}/${page}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: img.url, published: "false" }).toString(),
    });
    if (!res.ok) await graphError(res, "Photo upload");
    attached.push((await res.json() as { id: string }).id);
  }

  const feedParams = new URLSearchParams();
  if (p.text) feedParams.set("message", p.text);
  if (p.link) feedParams.set("link", p.link);
  attached.forEach((id, i) => feedParams.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));

  const res = await ctx.fetch(`${GRAPH}/${page}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: feedParams.toString(),
  });
  if (!res.ok) await graphError(res, "Feed post");
  const data = await res.json() as { id: string };
  return { id: data.id, url: `https://www.facebook.com/${data.id}` };
}

async function verify(ctx: AuthedCtx): Promise<AccountInfo> {
  // With a page token, /me is the page itself
  const res = await ctx.fetch(`${GRAPH}/me?fields=id,name`);
  if (!res.ok) await graphError(res, "Page lookup");
  const data = await res.json() as { id: string; name: string };
  return { id: data.id, username: data.id, displayName: data.name };
}

// user code-exchange token → long-lived user token → page token
async function finalizeAuth(
  raw: TokenResponse,
  opts: { clientId: string; clientSecret?: string; flags: Record<string, string | boolean> },
): Promise<FinalizedAuth> {
  const llRes = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret ?? "",
    fb_exchange_token: raw.access_token,
  })}`);
  if (!llRes.ok) {
    // URL carries secret + token — surface status only
    throw new AuthRequiredError(`Long-lived token exchange failed (${llRes.status}). Check app id/secret and try again.`);
  }
  const ll = await llRes.json() as { access_token: string };

  const pagesRes = await fetch(`${GRAPH}/me/accounts?${new URLSearchParams({ access_token: ll.access_token })}`);
  if (!pagesRes.ok) {
    throw new AuthRequiredError(`Listing pages failed (${pagesRes.status}). Does the app have pages_read_engagement?`);
  }
  const pages = (await pagesRes.json() as { data?: { id: string; name: string; access_token: string }[] }).data ?? [];
  if (!pages.length) {
    throw new ValidationError(
      "No Facebook Pages on this account. Facebook posting is Pages-only (personal timelines are API-dead since 2018). Create a Page or log in with the right account.",
    );
  }

  const want = typeof opts.flags["page"] === "string" ? String(opts.flags["page"]) : undefined;
  let page = want
    ? pages.find((pg) => pg.id === want || pg.name.toLowerCase() === want.toLowerCase())
    : pages.length === 1 ? pages[0] : undefined;
  if (!page) {
    const list = pages.map((pg) => `  ${pg.id}  ${pg.name}`).join("\n");
    throw new ValidationError(
      want
        ? `Page '${want}' not found. Your pages:\n${list}`
        : `Multiple pages — pick one with --page <id|name>:\n${list}`,
    );
  }

  return {
    access_token: page.access_token,
    expires_at: Date.now() + PAGE_TOKEN_LIFETIME_MS,
    profileExtras: { page_id: page.id, page_name: page.name },
  };
}

export const facebook: Provider = {
  id: "facebook",
  auth: {
    kind: "oauth",
    providerId: "facebook",
    authUrl: `https://www.facebook.com/${V}/dialog/oauth`,
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ["pages_manage_posts", "pages_read_engagement", "publish_video"],
    pkce: true,
    clientSecretRequired: true,
    refresh: "none",   // page token is effectively non-expiring
  },
  capabilities: {
    text: { maxChars: MAX_TEXT_CHARS, required: false },
    images: { max: MAX_IMAGES, formats: IMAGE_EXTS, maxBytes: 10 * 1024 ** 2 },
    video: { formats: VIDEO_EXTS, maxBytes: 10 * 1024 ** 3 },
    link: "inline",
    mediaSource: "public-url",
  },
  validate,
  post,
  verify,
  finalizeAuth,
};
