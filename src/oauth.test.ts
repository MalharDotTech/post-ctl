import { afterEach, describe, expect, test, spyOn, type Mock } from "bun:test";
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  buildAuthUrl, exchangeCode, refreshAccessToken, REDIRECT_URI,
} from "./oauth.ts";
import { jsonResponse, TEST_SECRETS } from "./__fixtures__/test-helpers.ts";

let fetchSpy: Mock<typeof fetch> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });

describe("PKCE", () => {
  test("verifier length within RFC 7636 bounds", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("challenge is base64url sha256, deterministic", async () => {
    // RFC 7636 appendix B test vector
    const challenge = await generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("state is 32 hex chars", () => {
    expect(generateState()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("buildAuthUrl", () => {
  test("includes PKCE, state, scopes, and extra params", () => {
    const url = new URL(buildAuthUrl({
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "cid",
      scopes: ["scope.a", "scope.b"],
      codeChallenge: "chal",
      state: "st",
      extraParams: { access_type: "offline", prompt: "consent" },
    }));
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("scope.a scope.b");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("token endpoint credential-leak boundary", () => {
  test("exchangeCode failure scrubs client_secret from error", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`invalid_grant for secret ${TEST_SECRETS.clientSecret}`, { status: 400 }),
    );
    try {
      await exchangeCode({
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        clientSecret: TEST_SECRETS.clientSecret,
        code: "code",
        codeVerifier: "verifier",
      });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(TEST_SECRETS.clientSecret);
      expect(msg).toContain("[redacted]");
    }
  });

  test("refreshAccessToken failure scrubs refresh_token and secret", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`bad ${TEST_SECRETS.refreshToken} / ${TEST_SECRETS.clientSecret}`, { status: 400 }),
    );
    try {
      await refreshAccessToken({
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: "cid",
        clientSecret: TEST_SECRETS.clientSecret,
        refreshToken: TEST_SECRETS.refreshToken,
      });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(TEST_SECRETS.refreshToken);
      expect(msg).not.toContain(TEST_SECRETS.clientSecret);
    }
  });

  test("exchangeCode sends client_secret and code_verifier in body", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer" }),
    );
    await exchangeCode({
      tokenUrl: "https://t", clientId: "cid", clientSecret: "sec", code: "c", codeVerifier: "v",
    });
    const body = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(body).toContain("client_secret=sec");
    expect(body).toContain("code_verifier=v");
    expect(body).toContain("grant_type=authorization_code");
  });
});
