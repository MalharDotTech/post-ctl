import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { presignUrl, stageFile, contentTypeFor, STAGING_SECRET_KEY } from "./stage.ts";
import { ValidationError } from "./errors.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { saveToken } from "./token-store.ts";
import { setupTestConfigDir, teardownTestConfigDir, makeTempVideo } from "./__fixtures__/test-helpers.ts";
import { writeFileSync } from "fs";
import { join } from "path";

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

describe("presignUrl (SigV4 query auth)", () => {
  // Official AWS SigV4 presigned-URL test vector (S3 docs, "Authenticating
  // Requests: Using Query Parameters"): virtual-hosted examplebucket,
  // us-east-1, GET test.txt, 20130524T000000Z, 86400s.
  test("matches the AWS documentation test vector", async () => {
    const url = await presignUrl({
      method: "GET",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      bucket: "",
      key: "test.txt",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
    expect(url).toContain("X-Amz-Date=20130524T000000Z");
    expect(url).toContain("X-Amz-SignedHeaders=host");
  });

  test("path-style R2 layout: /bucket/key with encoded segments", async () => {
    const url = await presignUrl({
      method: "PUT",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "postctl-staging",
      key: "postctl/a b.mp4",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "secret",
      expiresSeconds: 300,
    });
    expect(url).toStartWith("https://acct.r2.cloudflarestorage.com/postctl-staging/postctl/a%20b.mp4?");
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  test("different secret → different signature", async () => {
    const base = {
      method: "GET" as const, endpoint: "https://h.example.com", bucket: "b", key: "k",
      region: "auto", accessKeyId: "id", expiresSeconds: 60, now: new Date("2026-01-01T00:00:00Z"),
    };
    const a = await presignUrl({ ...base, secretAccessKey: "s1" });
    const b = await presignUrl({ ...base, secretAccessKey: "s2" });
    expect(a).not.toBe(b);
  });
});

describe("stageFile", () => {
  test("throws ValidationError with fix when staging unconfigured", async () => {
    const video = makeTempVideo(dir);
    expect(stageFile(video)).rejects.toThrow(ValidationError);
    expect(stageFile(video)).rejects.toThrow(/postctl staging set/);
  });

  test("round-trip against in-process S3 stub: PUT, presigned GET, DELETE cleanup", async () => {
    const objects = new Map<string, Uint8Array>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const key = new URL(req.url).pathname;
        // presigned query params must be present
        if (!new URL(req.url).searchParams.get("X-Amz-Signature")) return new Response("no sig", { status: 403 });
        if (req.method === "PUT") {
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response("", { status: 200 });
        }
        if (req.method === "GET") {
          const body = objects.get(key);
          return body ? new Response(body.slice()) : new Response("", { status: 404 });
        }
        if (req.method === "DELETE") {
          objects.delete(key);
          return new Response("", { status: 204 });
        }
        return new Response("", { status: 405 });
      },
    });

    try {
      const cfg = loadConfig();
      cfg.staging = {
        backend: "s3",
        endpoint: `http://localhost:${server.port}`,
        bucket: "test-bucket",
        region: "auto",
        accessKeyId: "test-id",
        prefix: "postctl/",
        presignTtlSeconds: 60,
      };
      saveConfig(cfg);
      saveToken(STAGING_SECRET_KEY, {
        access_token: "test-secret",
        expires_at: Number.MAX_SAFE_INTEGER,
        obtained_at: Date.now(),
      });

      const file = join(dir, "photo.jpg");
      writeFileSync(file, Buffer.alloc(256, 7));

      const staged = await stageFile(file);
      expect(staged.key).toStartWith("postctl/");
      expect(staged.key).toEndWith(".jpg");
      expect(objects.size).toBe(1);

      // The URL handed to the platform fetches the exact bytes
      const got = await fetch(staged.url);
      expect(got.status).toBe(200);
      expect((await got.arrayBuffer()).byteLength).toBe(256);

      await staged.cleanup();
      expect(objects.size).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe("contentTypeFor", () => {
  test("maps common types, falls back to octet-stream", () => {
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a.mp4")).toBe("video/mp4");
    expect(contentTypeFor("a.xyz")).toBe("application/octet-stream");
  });
});
