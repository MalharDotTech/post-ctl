import { existsSync, statSync } from "fs";
import { extname, basename } from "path";
import { ValidationError, ApiError } from "../errors.ts";
import { errorBody } from "../http.ts";
import type { Provider, Post, PostResult, AuthedCtx, AccountInfo } from "../provider.ts";

// YouTube Data API v3 provider. Resumable upload protocol:
//   1. POST videos.insert?uploadType=resumable → session URL in Location
//   2. PUT bytes to session URL
//   3. on interrupt: PUT with "Content-Range: bytes */N" → 308 + Range header
//      tells us the confirmed offset; resume from there (bounded attempts)
// Quota: upload = 1,600 units of the 10,000/day default ⇒ ~6 uploads/day.
// Unaudited API projects: uploads are forced Private regardless of the
// requested privacyStatus (projects created after Jul 2020) — default
// privacy is "private" and the result always includes the Studio URL.

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

const VIDEO_FORMATS = [".mp4", ".mov", ".avi", ".wmv", ".flv", ".webm", ".mkv", ".m4v", ".mpeg", ".mpg", ".3gp"];
const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_BYTES = 5000;
const MAX_TAGS_BYTES = 500;
const MAX_VIDEO_BYTES = 256 * 1024 ** 3;  // 256 GB API limit
const MAX_RESUME_ATTEMPTS = 5;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
  ".3gp": "video/3gpp",
};

function validate(post: Post): void {
  const errors: string[] = [];

  if (!post.text?.trim()) {
    errors.push("Title required (positional text argument is the video title).");
  } else {
    if (post.text.length > MAX_TITLE_CHARS) {
      errors.push(`Title too long: ${post.text.length} chars (max ${MAX_TITLE_CHARS}).`);
    }
    if (/[<>]/.test(post.text)) {
      errors.push("Title may not contain '<' or '>'.");
    }
  }

  if (!post.media || post.media.length !== 1) {
    errors.push("Exactly one --media video file required.");
  } else {
    const path = post.media[0]!.path;
    if (!existsSync(path)) {
      errors.push(`Media file not found: ${path}`);
    } else {
      const ext = extname(path).toLowerCase();
      if (!VIDEO_FORMATS.includes(ext)) {
        errors.push(`Unsupported video format '${ext}'. Supported: ${VIDEO_FORMATS.join(" ")}`);
      }
      const size = statSync(path).size;
      if (size === 0) errors.push(`Media file is empty: ${path}`);
      if (size > MAX_VIDEO_BYTES) errors.push(`Video exceeds 256 GB API limit.`);
    }
  }

  if (post.description && Buffer.byteLength(post.description, "utf8") > MAX_DESCRIPTION_BYTES) {
    errors.push(`Description too long: ${Buffer.byteLength(post.description, "utf8")} bytes (max ${MAX_DESCRIPTION_BYTES}).`);
  }
  if (post.description && /[<>]/.test(post.description)) {
    errors.push("Description may not contain '<' or '>'.");
  }
  if (post.tags && Buffer.byteLength(post.tags.join(","), "utf8") > MAX_TAGS_BYTES) {
    errors.push(`Tags too long (max ${MAX_TAGS_BYTES} bytes total).`);
  }
  if (post.link) {
    errors.push("YouTube has no link attachment — put URLs in --description.");
  }

  if (errors.length) throw new ValidationError(errors.join("\n"));
}

async function verify(ctx: AuthedCtx): Promise<AccountInfo> {
  const res = await ctx.fetch(`${API}/channels?part=snippet&mine=true`);
  if (!res.ok) {
    throw new ApiError(`channels.list failed (${res.status}): ${await errorBody(res)}`, res.status);
  }
  const data = await res.json() as { items?: { id: string; snippet: { title: string; customUrl?: string } }[] };
  const ch = data.items?.[0];
  if (!ch) {
    throw new ApiError(
      "No YouTube channel on this Google account. If the channel lives on a Brand Account, re-run auth login and pick the brand account at the Google account chooser.",
      404,
    );
  }
  return { id: ch.id, username: ch.snippet.customUrl ?? ch.id, displayName: ch.snippet.title };
}

async function post(ctx: AuthedCtx, p: Post): Promise<PostResult> {
  validate(p);
  const media = p.media![0]!;
  const file = Bun.file(media.path);
  const size = file.size;
  const mime = MIME_BY_EXT[extname(media.path).toLowerCase()] ?? "video/*";

  const metadata = {
    snippet: {
      title: p.text,
      description: p.description ?? "",
      ...(p.tags?.length ? { tags: p.tags } : {}),
    },
    status: {
      privacyStatus: p.privacy ?? "private",
      selfDeclaredMadeForKids: false,
    },
  };

  if (ctx.debug) {
    console.error(`[debug] youtube upload: ${basename(media.path)} (${size} bytes, ${mime})`);
    console.error(`[debug] quota: this upload costs 1,600 of 10,000 daily units (~6 uploads/day)`);
  }

  // 1. Initiate resumable session
  const initRes = await ctx.fetch(
    `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": mime,
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!initRes.ok) {
    throw new ApiError(
      `Upload initiation failed (${initRes.status}): ${await errorBody(initRes)}`,
      initRes.status,
    );
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) throw new ApiError("Upload initiation returned no session URL.", 500);

  // 2. Upload bytes; 3. resume on interrupt (bounded)
  let offset = 0;
  for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mime,
          "Content-Length": String(size - offset),
          ...(offset > 0 ? { "Content-Range": `bytes ${offset}-${size - 1}/${size}` } : {}),
        },
        body: offset > 0 ? file.slice(offset) : file,
      });
    } catch {
      offset = await queryOffset(ctx, sessionUrl, size);
      continue;
    }

    if (res.ok) {
      const video = await res.json() as { id: string; status?: { privacyStatus?: string; uploadStatus?: string } };
      const appliedPrivacy = video.status?.privacyStatus ?? "private";
      const requested = p.privacy ?? "private";
      const result: PostResult = {
        id: video.id,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        studioUrl: `https://studio.youtube.com/video/${video.id}/edit`,
        privacy: appliedPrivacy,
      };
      if (requested !== "private" && appliedPrivacy === "private") {
        // Unaudited-project downgrade — surface it, don't hide it
        result["warning"] =
          `Requested privacy '${requested}' but YouTube applied 'private' — unaudited API projects upload Private only. Publish manually in Studio or complete the compliance audit.`;
      }
      return result;
    }

    if (res.status === 308 || res.status >= 500) {
      offset = await queryOffset(ctx, sessionUrl, size);
      continue;
    }

    throw new ApiError(`Upload failed (${res.status}): ${await errorBody(res)}`, res.status);
  }
  throw new ApiError(`Upload failed after ${MAX_RESUME_ATTEMPTS} resume attempts.`, 0);
}

// Ask the session where it stands: "Content-Range: bytes */N" → 308 with a
// Range header like "bytes=0-12345" (confirmed through byte 12345).
async function queryOffset(ctx: AuthedCtx, sessionUrl: string, size: number): Promise<number> {
  const res = await ctx.fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${size}`, "Content-Length": "0" },
  });
  if (res.status !== 308) {
    if (res.ok) return size;  // finished while we were asking
    throw new ApiError(`Resume status check failed (${res.status}): ${await errorBody(res)}`, res.status);
  }
  const range = res.headers.get("range");
  if (!range) return 0;  // nothing received yet — restart from byte 0
  const match = /bytes=0-(\d+)/.exec(range);
  return match ? Number(match[1]) + 1 : 0;
}

export const youtube: Provider = {
  id: "youtube",
  auth: {
    kind: "oauth",
    providerId: "youtube",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    clientSecretRequired: true,
    refresh: "standard",
    // access_type=offline is what makes Google issue a refresh_token;
    // prompt=consent forces re-issue on repeat logins (otherwise Google
    // silently omits it and the profile dies with the first access token)
    authExtraParams: { access_type: "offline", prompt: "consent" },
  },
  capabilities: {
    text: { maxChars: MAX_TITLE_CHARS, required: true },
    video: { formats: VIDEO_FORMATS, maxBytes: MAX_VIDEO_BYTES, required: true },
    link: "unsupported",
    mediaSource: "upload",
  },
  validate,
  post,
  verify,
};
