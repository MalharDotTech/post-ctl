import { afterEach, beforeEach, describe, expect, test, spyOn, type Mock } from "bun:test";
import { instagram } from "./instagram.ts";
import { createAuthSession } from "../http.ts";
import { ApiError, AuthRequiredError } from "../errors.ts";
import type { AuthedCtx } from "../provider.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, jsonResponse,
} from "../__fixtures__/test-helpers.ts";

let dir: string;
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(() => {
  dir = setupTestConfigDir();
  seedToken("instagram/isha", { refresh_token: undefined });
});
afterEach(() => {
  teardownTestConfigDir(dir);
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const profile = { provider: "instagram", client_id: "cid", ig_user_id: "IGUSER" };

function ctx(): AuthedCtx {
  const s = createAuthSession(instagram.auth, "isha", profile, { retryDelayMs: 1 });
  return { fetch: s.fetch, profileName: "isha", profile, debug: false, pollDelayMs: 1 };
}

const IMG = { path: "/x/a.jpg", url: "https://staged/a.jpg" };
const VID = { path: "/x/v.mp4", url: "https://staged/v.mp4" };

describe("instagram.validate", () => {
  test("requires media; allows 1–10; rejects 11", () => {
    expect(() => instagram.validate({ text: "cap" })).toThrow(/requires --media/);
    expect(() => instagram.validate({ text: "cap", media: [IMG] })).not.toThrow();
    expect(() => instagram.validate({ text: "cap", media: [IMG, VID] })).not.toThrow();
    expect(() => instagram.validate({ text: "cap", media: Array(11).fill(IMG) })).toThrow(/Carousel max 10/);
  });

  test("caption over 2200 chars rejected; link rejected", () => {
    expect(() => instagram.validate({ text: "x".repeat(2201), media: [IMG] })).toThrow(/Caption too long/);
    expect(() => instagram.validate({ text: "c", media: [IMG], link: "https://x" })).toThrow(/bio link/);
  });

  test("unsupported format rejected", () => {
    expect(() => instagram.validate({ text: "c", media: [{ url: "https://staged/a.bmp" }] })).toThrow(/Unsupported/);
  });
});

describe("instagram.post", () => {
  test("image: container → immediate FINISHED → publish → permalink", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "CONT1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "MEDIA1" }))
      .mockResolvedValueOnce(jsonResponse({ permalink: "https://www.instagram.com/p/abc/" }));

    const r = await instagram.post(ctx(), { text: "caption", media: [IMG] });
    expect(r).toEqual({ id: "MEDIA1", url: "https://www.instagram.com/p/abc/" });

    const createBody = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/IGUSER/media");
    expect(createBody).toContain(`image_url=${encodeURIComponent(IMG.url)}`);
    expect(createBody).toContain("caption=caption");
    expect(createBody).not.toContain("media_type");

    const publishBody = String(fetchSpy.mock.calls[2]![1]!.body);
    expect(String(fetchSpy.mock.calls[2]![0])).toContain("/IGUSER/media_publish");
    expect(publishBody).toContain("creation_id=CONT1");
  });

  test("video: REELS container, polls through IN_PROGRESS to FINISHED", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "CONT2" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "MEDIA2" }))
      .mockResolvedValueOnce(jsonResponse({ permalink: "https://www.instagram.com/reel/xyz/" }));

    const r = await instagram.post(ctx(), { text: "reel", media: [VID] });
    expect(r.id).toBe("MEDIA2");
    const createBody = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(createBody).toContain("media_type=REELS");
    expect(createBody).toContain(`video_url=${encodeURIComponent(VID.url)}`);
  });

  test("container ERROR → ApiError with actionable causes", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "CONT3" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "ERROR" }));
    try {
      await instagram.post(ctx(), { text: "c", media: [VID] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as Error).message).toContain("aspect ratio");
    }
  });

  test("publish succeeds even if permalink lookup fails", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "CONT4" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "MEDIA4" }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const r = await instagram.post(ctx(), { text: "c", media: [IMG] });
    expect(r.id).toBe("MEDIA4");
    expect(r.url).toBeUndefined();
  });

  test("carousel: child containers → parent CAROUSEL → publish", async () => {
    const IMG2 = { path: "/x/b.png", url: "https://staged/b.png" };
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "CH1" }))          // child 1
      .mockResolvedValueOnce(jsonResponse({ id: "CH2" }))          // child 2 (video)
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))  // poll CH1
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))  // poll CH2
      .mockResolvedValueOnce(jsonResponse({ id: "PARENT" }))       // parent
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))  // poll parent
      .mockResolvedValueOnce(jsonResponse({ id: "MEDIA9" }))       // publish
      .mockResolvedValueOnce(jsonResponse({ permalink: "https://www.instagram.com/p/car/" }));

    const r = await instagram.post(ctx(), { text: "carousel cap", media: [IMG, VID] });
    expect(r.id).toBe("MEDIA9");

    const child1 = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(child1).toContain("is_carousel_item=true");
    expect(child1).toContain(`image_url=${encodeURIComponent(IMG.url)}`);
    expect(child1).not.toContain("caption");

    const child2 = String(fetchSpy.mock.calls[1]![1]!.body);
    expect(child2).toContain("media_type=VIDEO");   // carousel child, not REELS
    expect(child2).toContain(`video_url=${encodeURIComponent(VID.url)}`);

    const parent = String(fetchSpy.mock.calls[4]![1]!.body);
    expect(parent).toContain("media_type=CAROUSEL");
    expect(parent).toContain(`children=${encodeURIComponent("CH1,CH2")}`);
    expect(parent).toContain("caption=carousel+cap");

    const publish = String(fetchSpy.mock.calls[6]![1]!.body);
    expect(publish).toContain("creation_id=PARENT");
  });

  test("missing ig_user_id → AuthRequiredError", async () => {
    const s = createAuthSession(instagram.auth, "isha", { provider: "instagram" }, { retryDelayMs: 1 });
    const bare: AuthedCtx = { fetch: s.fetch, profileName: "isha", profile: { provider: "instagram" }, debug: false };
    expect(instagram.post(bare, { text: "c", media: [IMG] })).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe("instagram.verify", () => {
  test("returns ig identity", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ user_id: 12345, username: "isha.foundation" }));
    const info = await instagram.verify(ctx());
    expect(info).toEqual({ id: "12345", username: "isha.foundation", displayName: "isha.foundation" });
  });
});

describe("instagram.finalizeAuth", () => {
  test("exchanges short-lived for long-lived, captures ig_user_id", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "LONG-IG-TOKEN", token_type: "bearer", expires_in: 5184000 }),
    );
    const fin = await instagram.finalizeAuth!(
      { access_token: "SHORT-IG-TOKEN", user_id: 99887 },
      { clientId: "cid", clientSecret: "IGSECRET", flags: {} },
    );
    expect(fin.access_token).toBe("LONG-IG-TOKEN");
    expect(fin.profileExtras).toEqual({ ig_user_id: "99887" });
    expect(fin.expires_at).toBeGreaterThan(Date.now() + 59 * 24 * 3600_000);

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("grant_type=ig_exchange_token");
  });

  test("exchange failure never leaks secret or token", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 400 }));
    try {
      await instagram.finalizeAuth!(
        { access_token: "SHORT-IG-TOKEN", user_id: 1 },
        { clientId: "cid", clientSecret: "IGSECRET", flags: {} },
      );
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("IGSECRET");
      expect((e as Error).message).not.toContain("SHORT-IG-TOKEN");
    }
  });
});

describe("instagram exchange refresh (http.ts integration)", () => {
  test("token older than 30d refreshes via ig_refresh_token before request", async () => {
    seedToken("instagram/isha", {
      refresh_token: undefined,
      obtained_at: Date.now() - 31 * 24 * 3600_000,
      expires_at: Date.now() + 29 * 24 * 3600_000,
    });
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "REFRESHED", expires_in: 5184000 }))
      .mockResolvedValueOnce(jsonResponse({ user_id: 1, username: "u" }));
    await instagram.verify(ctx());

    const refreshUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(refreshUrl).toContain("refresh_access_token");
    expect(refreshUrl).toContain("grant_type=ig_refresh_token");
    const apiHeaders = fetchSpy.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(apiHeaders["Authorization"]).toBe("Bearer REFRESHED");
  });

  test("expired Meta token → AuthRequiredError, no network", async () => {
    seedToken("instagram/isha", { refresh_token: undefined, expires_at: Date.now() - 1 });
    fetchSpy = spyOn(globalThis, "fetch");
    expect(instagram.verify(ctx())).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  test("opportunistic refresh failure falls back to still-valid token", async () => {
    seedToken("instagram/isha", {
      refresh_token: undefined,
      obtained_at: Date.now() - 31 * 24 * 3600_000,
      expires_at: Date.now() + 29 * 24 * 3600_000,
    });
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("transient", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ user_id: 1, username: "u" }));
    const info = await instagram.verify(ctx());
    expect(info.username).toBe("u");
  });
});
