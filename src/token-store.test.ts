import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadToken, saveToken, deleteToken, isTokenExpired } from "./token-store.ts";
import { setupTestConfigDir, teardownTestConfigDir, seedToken } from "./__fixtures__/test-helpers.ts";
import { statSync } from "fs";
import { join } from "path";

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

describe("token-store (file fallback, keychain disabled)", () => {
  test("save/load round-trip keyed by provider/profile", () => {
    const token = seedToken("youtube/isha");
    expect(loadToken("youtube/isha")).toEqual(token);
    expect(loadToken("youtube/other")).toBeNull();
  });

  test("delete removes token", () => {
    seedToken("youtube/isha");
    deleteToken("youtube/isha");
    expect(loadToken("youtube/isha")).toBeNull();
  });

  test("tokens.json written 0o600", () => {
    seedToken("youtube/isha");
    const mode = statSync(join(dir, "tokens.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("isTokenExpired honors 5-min proactive buffer", () => {
    const fresh = seedToken("a/b", { expires_at: Date.now() + 3600_000 });
    const nearExpiry = seedToken("a/c", { expires_at: Date.now() + 60_000 });
    const expired = seedToken("a/d", { expires_at: Date.now() - 1 });
    expect(isTokenExpired(fresh)).toBe(false);
    expect(isTokenExpired(nearExpiry)).toBe(true);
    expect(isTokenExpired(expired)).toBe(true);
  });
});
