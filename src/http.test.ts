import { afterEach, beforeEach, describe, expect, test, spyOn, type Mock } from "bun:test";
import { createAuthSession } from "./http.ts";
import { AuthRequiredError, ApiError } from "./errors.ts";
import { loadToken } from "./token-store.ts";
import { youtube } from "./providers/youtube.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, jsonResponse, TEST_SECRETS,
} from "./__fixtures__/test-helpers.ts";

const spec = youtube.auth;
const profile = { provider: "youtube", client_id: "cid" };

let dir: string;
let fetchSpy: Mock<typeof fetch> | undefined;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => {
  teardownTestConfigDir(dir);
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function session() {
  return createAuthSession(spec, "isha", profile, { retryDelayMs: 1 });
}

describe("createAuthSession", () => {
  test("no stored token → AuthRequiredError naming the login command", async () => {
    const s = session();
    try {
      await s.fetch("https://api.example.com/x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthRequiredError);
      expect((e as Error).message).toContain("postctl auth login youtube --account isha");
    }
  });

  test("injects Bearer token, passes through success", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    const res = await session().fetch("https://api.example.com/x");
    expect(res.status).toBe(200);
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_SECRETS.accessToken}`);
  });

  test("proactively refreshes expired token before request and persists it", async () => {
    seedToken("youtube/isha", { expires_at: Date.now() - 1 });
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-at", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await session().fetch("https://api.example.com/x");

    // First call = token endpoint, second = API with new token
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(spec.tokenUrl);
    const apiHeaders = fetchSpy.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(apiHeaders["Authorization"]).toBe("Bearer new-at");

    const stored = loadToken("youtube/isha")!;
    expect(stored.access_token).toBe("new-at");
    // Google omits refresh_token on refresh — old one must survive
    expect(stored.refresh_token).toBe(TEST_SECRETS.refreshToken);
  });

  test("reactive refresh on 401, then retry once", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauth", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-at", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await session().fetch("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls.length).toBe(3);
  });

  test("second 401 after refresh → AuthRequiredError", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauth", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-at", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(new Response("still unauth", { status: 401 }));
    await expect(session().fetch("https://api.example.com/x")).rejects.toBeInstanceOf(AuthRequiredError);
  });

  test("refresh failure → AuthRequiredError with scrubbed message", async () => {
    seedToken("youtube/isha", { expires_at: Date.now() - 1 });
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`invalid_grant ${TEST_SECRETS.refreshToken}`, { status: 400 }),
    );
    try {
      await session().fetch("https://api.example.com/x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthRequiredError);
      expect((e as Error).message).not.toContain(TEST_SECRETS.refreshToken);
    }
  });

  test("expired token with no refresh_token → AuthRequiredError, no network", async () => {
    seedToken("youtube/isha", { expires_at: Date.now() - 1, refresh_token: undefined });
    fetchSpy = spyOn(globalThis, "fetch");
    await expect(session().fetch("https://api.example.com/x")).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  test("bounded retry on 429 then success", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await session().fetch("https://api.example.com/x");
    expect(res.status).toBe(200);
  });

  test("5xx exhausts retries and returns last response", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await session().fetch("https://api.example.com/x");
    expect(res.status).toBe(500);
    expect(fetchSpy.mock.calls.length).toBe(3);  // MAX_RETRIES
  });

  test("network failure after retries → ApiError without token in message", async () => {
    seedToken("youtube/isha");
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    try {
      await session().fetch("https://api.example.com/x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as Error).message).not.toContain(TEST_SECRETS.accessToken);
    }
  });
});
