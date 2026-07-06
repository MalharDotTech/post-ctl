import { afterEach, beforeEach, describe, expect, test, spyOn, type Mock } from "bun:test";
import { facebook } from "./facebook.ts";
import { createAuthSession } from "../http.ts";
import { ValidationError, AuthRequiredError } from "../errors.ts";
import type { AuthedCtx } from "../provider.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, jsonResponse,
} from "../__fixtures__/test-helpers.ts";

let dir: string;
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(() => {
  dir = setupTestConfigDir();
  seedToken("facebook/isha", { refresh_token: undefined });
});
afterEach(() => {
  teardownTestConfigDir(dir);
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const profile = { provider: "facebook", client_id: "cid", page_id: "PAGE1", page_name: "Isha" };

function ctx(): AuthedCtx {
  const s = createAuthSession(facebook.auth, "isha", profile, { retryDelayMs: 1 });
  return { fetch: s.fetch, profileName: "isha", profile, debug: false };
}

const IMG = { path: "/x/a.jpg", url: "https://staged/a.jpg" };
const IMG2 = { path: "/x/b.png", url: "https://staged/b.png" };
const VID = { path: "/x/v.mp4", url: "https://staged/v.mp4" };

describe("facebook.validate", () => {
  test("text-only ok; empty post rejected", () => {
    expect(() => facebook.validate({ text: "hello" })).not.toThrow();
    expect(() => facebook.validate({ text: "" })).toThrow(/text or --media/);
  });

  test("video+images mix rejected; multiple videos rejected", () => {
    expect(() => facebook.validate({ text: "t", media: [VID, IMG] })).toThrow(/mix/);
    expect(() => facebook.validate({ text: "t", media: [VID, { ...VID }] })).toThrow(/one video/);
  });

  test("unsupported extension rejected", () => {
    expect(() => facebook.validate({ text: "t", media: [{ url: "https://staged/a.tiff" }] })).toThrow(/Unsupported/);
  });

  test("link with video rejected; link with text ok", () => {
    expect(() => facebook.validate({ text: "t", media: [VID], link: "https://x" })).toThrow(ValidationError);
    expect(() => facebook.validate({ text: "t", link: "https://x" })).not.toThrow();
  });
});

describe("facebook.post", () => {
  test("text+link → /feed", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "PAGE1_123" }));
    const r = await facebook.post(ctx(), { text: "hello", link: "https://example.com" });
    expect(r.id).toBe("PAGE1_123");
    expect(r.url).toBe("https://www.facebook.com/PAGE1_123");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/PAGE1/feed");
    const body = String(init!.body);
    expect(body).toContain("message=hello");
    expect(body).toContain(`link=${encodeURIComponent("https://example.com")}`);
  });

  test("images → unpublished photos + attached_media feed", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "PH1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "PH2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "PAGE1_456" }));
    const r = await facebook.post(ctx(), { text: "two pics", media: [IMG, IMG2] });
    expect(r.id).toBe("PAGE1_456");

    const photo1 = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/PAGE1/photos");
    expect(photo1).toContain(`url=${encodeURIComponent(IMG.url)}`);
    expect(photo1).toContain("published=false");

    const feed = String(fetchSpy.mock.calls[2]![1]!.body);
    expect(feed).toContain(encodeURIComponent(JSON.stringify({ media_fbid: "PH1" })));
    expect(feed).toContain(encodeURIComponent(JSON.stringify({ media_fbid: "PH2" })));
  });

  test("video → /videos with file_url", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "V9" }));
    const r = await facebook.post(ctx(), { text: "vid", media: [VID] });
    expect(r.url).toBe("https://www.facebook.com/PAGE1/videos/V9");
    const body = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/PAGE1/videos");
    expect(body).toContain(`file_url=${encodeURIComponent(VID.url)}`);
    expect(body).toContain("description=vid");
  });

  test("missing page binding → AuthRequiredError", async () => {
    const s = createAuthSession(facebook.auth, "isha", { provider: "facebook", client_id: "cid" }, { retryDelayMs: 1 });
    const bare: AuthedCtx = { fetch: s.fetch, profileName: "isha", profile: { provider: "facebook" }, debug: false };
    expect(facebook.post(bare, { text: "x" })).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe("facebook.verify", () => {
  test("page identity via /me with page token", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "PAGE1", name: "Isha" }));
    const info = await facebook.verify(ctx());
    expect(info).toEqual({ id: "PAGE1", username: "PAGE1", displayName: "Isha" });
  });
});

describe("facebook.finalizeAuth", () => {
  const raw = { access_token: "SHORT-USER-TOKEN" };
  const opts = { clientId: "cid", clientSecret: "APPSECRET", flags: {} as Record<string, string | boolean> };

  test("exchanges long-lived, auto-selects single page, stores page token", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "LONG-USER-TOKEN" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "PAGE1", name: "Isha", access_token: "PAGE-TOKEN" }] }));
    const fin = await facebook.finalizeAuth!(raw, opts);
    expect(fin.access_token).toBe("PAGE-TOKEN");
    expect(fin.profileExtras).toEqual({ page_id: "PAGE1", page_name: "Isha" });
    expect(fin.expires_at).toBeGreaterThan(Date.now() + 365 * 24 * 3600_000);

    const exchangeUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(exchangeUrl).toContain("grant_type=fb_exchange_token");
    expect(exchangeUrl).toContain("fb_exchange_token=SHORT-USER-TOKEN");
  });

  test("multiple pages without --page → ValidationError listing pages", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "LL" }))
      .mockResolvedValueOnce(jsonResponse({ data: [
        { id: "P1", name: "One", access_token: "T1" },
        { id: "P2", name: "Two", access_token: "T2" },
      ] }));
    try {
      await facebook.finalizeAuth!(raw, opts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as Error).message).toContain("--page");
      expect((e as Error).message).toContain("Two");
    }
  });

  test("--page selects by name case-insensitively", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "LL" }))
      .mockResolvedValueOnce(jsonResponse({ data: [
        { id: "P1", name: "One", access_token: "T1" },
        { id: "P2", name: "Two", access_token: "T2" },
      ] }));
    const fin = await facebook.finalizeAuth!(raw, { ...opts, flags: { page: "two" } });
    expect(fin.access_token).toBe("T2");
  });

  test("no pages → ValidationError explaining Pages-only policy", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "LL" }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    expect(facebook.finalizeAuth!(raw, opts)).rejects.toThrow(/Pages-only|Pages/);
  });

  test("exchange failure never leaks app secret", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 400 }));
    try {
      await facebook.finalizeAuth!(raw, opts);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("APPSECRET");
      expect((e as Error).message).not.toContain("SHORT-USER-TOKEN");
    }
  });
});
