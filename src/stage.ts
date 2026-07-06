import { statSync } from "fs";
import { extname } from "path";
import { loadConfig, type StagingConfig } from "./config.ts";
import { loadToken } from "./token-store.ts";
import { ValidationError, ApiError } from "./errors.ts";

// Media staging for public-url providers (Instagram, Facebook media).
// Hand-rolled SigV4 *query* presign (UNSIGNED-PAYLOAD, host-only signed
// header) on crypto.subtle — R2 and AWS S3 share the algorithm; only
// endpoint/region differ. Bucket stays private: Meta fetches through a
// short-TTL presigned GET; object is deleted best-effort after publish
// (document a 1-day bucket lifecycle rule as the backstop).

export const STAGING_SECRET_KEY = "staging/default";  // token-store key

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
};

export function contentTypeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// ── Config resolution ──────────────────────────────────────────────────────────

export function getStagingConfig(): { cfg: StagingConfig; secretAccessKey: string } {
  const staging = loadConfig().staging;
  if (!staging || staging.backend === "none") {
    throw new ValidationError(
      "Media staging not configured (this provider publishes from a public URL).\n" +
      "Run: postctl staging set --endpoint <url> --bucket <name> --region auto " +
      "--access-key-id <id> --secret-access-key <key>\n" +
      "Or pass an already-hosted asset with --media-url <https://…>",
    );
  }
  // Secret rides the token store (keychain), never profiles.json — the
  // StoredToken shape is reused with the secret in access_token.
  const secret = loadToken(STAGING_SECRET_KEY)?.access_token;
  if (!secret) {
    throw new ValidationError(
      "Staging secret key missing from token store. Re-run: postctl staging set … --secret-access-key <key>",
    );
  }
  return { cfg: staging, secretAccessKey: secret };
}

// ── SigV4 presign ──────────────────────────────────────────────────────────────

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key.buffer as ArrayBuffer : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

// RFC 3986 strict encoding (S3 requires %20 not +, and encoded ! ' ( ) *)
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface PresignOpts {
  method: "GET" | "PUT" | "DELETE";
  endpoint: string;          // https://host — path-style (R2 default)
  bucket: string;
  key: string;               // object key, no leading slash
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now?: Date;                // injectable for deterministic tests
}

export async function presignUrl(o: PresignOpts): Promise<string> {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");  // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${o.region}/s3/aws4_request`;
  const host = new URL(o.endpoint).host;
  // Path-style (R2 default): /bucket/key. Empty bucket = virtual-hosted
  // endpoint (bucket already in the host) — also what the AWS SigV4 test
  // vector uses.
  const canonicalUri = (o.bucket ? `/${rfc3986(o.bucket)}` : "") + "/" + o.key.split("/").map(rfc3986).join("/");

  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${o.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(o.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = params
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    o.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key: ArrayBuffer = await hmac(new TextEncoder().encode(`AWS4${o.secretAccessKey}`), dateStamp);
  key = await hmac(key, o.region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return `${o.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── Staging flow ───────────────────────────────────────────────────────────────

export interface StagedMedia {
  url: string;               // presigned GET — hand this to the platform
  key: string;
  cleanup(): Promise<void>;  // best-effort presigned DELETE
}

export async function stageFile(path: string): Promise<StagedMedia> {
  const { cfg, secretAccessKey } = getStagingConfig();
  const size = statSync(path).size;
  if (size === 0) throw new ValidationError(`Media file is empty: ${path}`);

  const prefix = cfg.prefix ?? "postctl/";
  const key = `${prefix}${crypto.randomUUID()}${extname(path).toLowerCase()}`;
  const ttl = cfg.presignTtlSeconds ?? 3600;
  const base = {
    endpoint: cfg.endpoint, bucket: cfg.bucket, key, region: cfg.region,
    accessKeyId: cfg.accessKeyId, secretAccessKey,
  };

  const putUrl = await presignUrl({ ...base, method: "PUT", expiresSeconds: 300 });
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentTypeFor(path), "Content-Length": String(size) },
    body: Bun.file(path),
  });
  if (!putRes.ok) {
    // Presigned URL carries the signature — never echo the URL itself
    throw new ApiError(
      `Staging upload failed (${putRes.status}) to bucket '${cfg.bucket}'. Check staging config: postctl staging status`,
      putRes.status,
    );
  }

  const getUrl = await presignUrl({ ...base, method: "GET", expiresSeconds: ttl });
  return {
    url: getUrl,
    key,
    cleanup: async () => {
      try {
        const delUrl = await presignUrl({ ...base, method: "DELETE", expiresSeconds: 300 });
        await fetch(delUrl, { method: "DELETE" });
      } catch {
        // TTL + bucket lifecycle rule are the backstop
      }
    },
  };
}
