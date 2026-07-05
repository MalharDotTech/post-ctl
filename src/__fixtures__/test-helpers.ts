import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveToken, type StoredToken } from "../token-store.ts";

// Isolated config dir per test — config.ts/token-store.ts read
// POSTCTL_CONFIG_DIR at call time (ADR-004), so setting it here is enough.
export function setupTestConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "postctl-test-"));
  process.env["POSTCTL_CONFIG_DIR"] = dir;
  process.env["POSTCTL_NO_KEYCHAIN"] = "1";
  return dir;
}

export function teardownTestConfigDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["POSTCTL_CONFIG_DIR"];
  delete process.env["POSTCTL_NO_KEYCHAIN"];
}

export const TEST_SECRETS = {
  accessToken: "ya29.TEST-ACCESS-TOKEN-VALUE",
  refreshToken: "1//TEST-REFRESH-TOKEN-VALUE",
  clientSecret: "GOCSPX-TEST-CLIENT-SECRET",
};

export function seedToken(key: string, overrides: Partial<StoredToken> = {}): StoredToken {
  const token: StoredToken = {
    access_token: TEST_SECRETS.accessToken,
    refresh_token: TEST_SECRETS.refreshToken,
    expires_at: Date.now() + 3600_000,
    client_secret: TEST_SECRETS.clientSecret,
    obtained_at: Date.now(),
    ...overrides,
  };
  saveToken(key, token);
  return token;
}

export function makeTempVideo(dir: string, name = "test.mp4", bytes = 1024): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
