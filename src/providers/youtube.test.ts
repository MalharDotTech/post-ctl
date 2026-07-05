import { afterEach, beforeEach, describe, expect, test, spyOn, type Mock } from "bun:test";
import { youtube } from "./youtube.ts";
import { createAuthSession } from "../http.ts";
import { ValidationError, ApiError } from "../errors.ts";
import type { AuthedCtx } from "../provider.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, makeTempVideo, jsonResponse,
} from "../__fixtures__/test-helpers.ts";

let dir: string;
let fetchSpy: Mock<typeof fetch> | undefined;
let video: string;

beforeEach(() => {
  dir = setupTestConfigDir();
  video = makeTempVideo(dir);
  seedToken("youtube/isha");
});
afterEach(() => {
  teardownTestConfigDir(dir);
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function ctx(): AuthedCtx {
  const s = createAuthSession(youtube.auth, "isha", { provider: "youtube", client_id: "cid" }, { retryDelayMs: 1 });
  return { fetch: s.fetch, profileName: "isha", profile: s.profile, debug: false };
}

const SESSION_URL = "https://upload.googleapis.com/session/abc123";

describe("youtube.validate", () => {
  test("happy path", () => {
    expect(() => youtube.validate({ text: "A title", media: [{ path: video }] })).not.toThrow();
  });

  test("missing title", () => {
    expect(() => youtube.validate({ text: "", media: [{ path: video }] })).toThrow(ValidationError);
  });

  test("title over 100 chars", () => {
    expect(() => youtube.validate({ text: "x".repeat(101), media: [{ path: video }] })).toThrow(/Title too long/);
  });

  test("angle brackets rejected in title", () => {
    expect(() => youtube.validate({ text: "bad <title>", media: [{ path: video }] })).toThrow(/'<' or '>'/);
  });

  test("missing media", () => {
    expect(() => youtube.validate({ text: "t" })).toThrow(/Exactly one --media/);
  });

  test("nonexistent file", () => {
    expect(() => youtube.validate({ text: "t", media: [{ path: "/nope/void.mp4" }] })).toThrow(/not found/);
  });

  test("unsupported extension", () => {
    expect(() => youtube.validate({ text: "t", media: [{ path: makeTempVideo(dir, "x.gif") }] })).toThrow(/Unsupported video format/);
  });

  test("link flag rejected with guidance", () => {
    expect(() => youtube.validate({ text: "t", media: [{ path: video }], link: "https://x.com" })).toThrow(/--description/);
  });

  test("description over 5000 bytes", () => {
    expect(() => youtube.validate({ text: "t", media: [{ path: video }], description: "d".repeat(5001) })).toThrow(/Description too long/);
  });
});

describe("youtube.verify", () => {
  test("returns channel identity", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      items: [{ id: "UC123", snippet: { title: "Isha Foundation", customUrl: "@ishafoundation" } }],
    }));
    const info = await youtube.verify(ctx());
    expect(info).toEqual({ id: "UC123", username: "@ishafoundation", displayName: "Isha Foundation" });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("channels?part=snippet&mine=true");
  });

  test("no channel → ApiError mentioning brand accounts", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await expect(youtube.verify(ctx())).rejects.toThrow(/Brand Account/);
  });
});

describe("youtube.post (resumable upload)", () => {
  test("happy path: initiate → PUT → video resource", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { Location: SESSION_URL } }))
      .mockResolvedValueOnce(jsonResponse({ id: "vid123", status: { privacyStatus: "private" } }));

    const result = await youtube.post(ctx(), { text: "A title", media: [{ path: video }], privacy: "private" });

    expect(result.id).toBe("vid123");
    expect(result.url).toBe("https://www.youtube.com/watch?v=vid123");
    expect(result["studioUrl"]).toBe("https://studio.youtube.com/video/vid123/edit");
    expect(result["warning"]).toBeUndefined();

    // Initiation request carries metadata + upload headers
    const [initUrl, initInit] = fetchSpy.mock.calls[0]!;
    expect(String(initUrl)).toContain("uploadType=resumable");
    const initHeaders = initInit!.headers as Record<string, string>;
    expect(initHeaders["X-Upload-Content-Type"]).toBe("video/mp4");
    expect(initHeaders["X-Upload-Content-Length"]).toBe("1024");
    const meta = JSON.parse(String(initInit!.body));
    expect(meta.snippet.title).toBe("A title");
    expect(meta.status.privacyStatus).toBe("private");

    // Bytes PUT to session URL
    expect(String(fetchSpy.mock.calls[1]![0])).toBe(SESSION_URL);
    expect(fetchSpy.mock.calls[1]![1]!.method).toBe("PUT");
  });

  test("privacy downgrade by unaudited project surfaces warning", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { Location: SESSION_URL } }))
      .mockResolvedValueOnce(jsonResponse({ id: "vid123", status: { privacyStatus: "private" } }));
    const result = await youtube.post(ctx(), { text: "t", media: [{ path: video }], privacy: "public" });
    expect(String(result["warning"])).toContain("unaudited");
  });

  test("defaults to private privacy", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { Location: SESSION_URL } }))
      .mockResolvedValueOnce(jsonResponse({ id: "v", status: { privacyStatus: "private" } }));
    await youtube.post(ctx(), { text: "t", media: [{ path: video }] });
    const meta = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(meta.status.privacyStatus).toBe("private");
  });

  test("resumes from confirmed offset after interrupted upload", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      // initiate
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { Location: SESSION_URL } }))
      // first PUT dies mid-flight (http.ts retries network errors internally
      // 3x, so feed it 3 rejections)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      // offset query → 512 bytes confirmed
      .mockResolvedValueOnce(new Response("", { status: 308, headers: { Range: "bytes=0-511" } }))
      // resumed PUT succeeds
      .mockResolvedValueOnce(jsonResponse({ id: "vid123", status: { privacyStatus: "private" } }));

    const result = await youtube.post(ctx(), { text: "t", media: [{ path: video }] });
    expect(result.id).toBe("vid123");

    // Offset-query request declares total size
    const offsetHeaders = fetchSpy.mock.calls[4]![1]!.headers as Record<string, string>;
    expect(offsetHeaders["Content-Range"]).toBe("bytes */1024");
    // Resumed PUT starts at byte 512
    const resumeHeaders = fetchSpy.mock.calls[5]![1]!.headers as Record<string, string>;
    expect(resumeHeaders["Content-Range"]).toBe("bytes 512-1023/1024");
  });

  test("initiation failure → ApiError with status", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "quotaExceeded" } }), { status: 403 }),
    );
    try {
      await youtube.post(ctx(), { text: "t", media: [{ path: video }] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as Error).message).toContain("quotaExceeded");
    }
  });

  test("4xx during upload PUT is not retried as resume", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { Location: SESSION_URL } }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(youtube.post(ctx(), { text: "t", media: [{ path: video }] })).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy.mock.calls.length).toBe(2);
  });
});
