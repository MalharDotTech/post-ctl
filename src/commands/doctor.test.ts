import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { diagnose } from "./doctor.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, TEST_SECRETS,
} from "../__fixtures__/test-helpers.ts";

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

function writeProfiles(cfg: unknown): void {
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(cfg));
}

function healthy(): void {
  writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: "cid", channel_title: "Isha" } } });
  seedToken("youtube/isha");  // valid, refreshable
}

const row = (r: Awaited<ReturnType<typeof diagnose>>, check: string) =>
  r.rows.find((x) => x.check === check);

describe("doctor diagnose", () => {
  test("healthy setup → ok, no fail rows", async () => {
    healthy();
    const r = await diagnose();
    expect(r.ok).toBe(true);
    expect(r.rows.some((x) => x.status === "fail")).toBe(false);
    expect(row(r, "config-dir")?.status).toBe("ok");
    expect(row(r, "profiles")?.status).toBe("ok");
    expect(row(r, "isha: token-expiry")?.status).toBe("ok");
  });

  test("no profiles → fail with setup fix", async () => {
    writeProfiles({ default: "", profiles: {} });
    const r = await diagnose();
    expect(r.ok).toBe(false);
    expect(row(r, "profiles")?.status).toBe("fail");
    expect(row(r, "profiles")?.fix).toContain("postctl setup youtube");
  });

  test("missing token → fail with auth login fix", async () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: "cid" } } });
    const r = await diagnose();
    expect(r.ok).toBe(false);
    expect(row(r, "isha: token")?.status).toBe("fail");
    expect(row(r, "isha: token")?.fix).toContain("auth login youtube --account isha");
  });

  test("expired token without refresh → fail", async () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: "cid" } } });
    seedToken("youtube/isha", { expires_at: Date.now() - 60_000, refresh_token: undefined });
    const r = await diagnose();
    expect(r.ok).toBe(false);
    expect(row(r, "isha: refresh-token")?.status).toBe("fail");
    expect(row(r, "isha: token-expiry")?.status).toBe("fail");
  });

  test("unknown provider → fail", async () => {
    writeProfiles({ default: "x", profiles: { x: { provider: "myspace" } } });
    const r = await diagnose();
    expect(r.ok).toBe(false);
    expect(row(r, "x: provider")?.status).toBe("fail");
  });

  test("file-backed token with wrong perms → fail", async () => {
    healthy();
    chmodSync(join(dir, "tokens.json"), 0o644);
    const r = await diagnose();
    expect(r.ok).toBe(false);
    const perm = r.rows.find((x) => x.check.endsWith("token-perms"));
    expect(perm?.status).toBe("fail");
    expect(perm?.fix).toContain("chmod 600");
  });

  test("incomplete staging → fail", async () => {
    healthy();
    writeProfiles({
      default: "isha",
      profiles: { isha: { provider: "youtube", client_id: "cid" } },
      staging: { backend: "r2", endpoint: "https://x.r2.cloudflarestorage.com", bucket: "b", region: "auto", accessKeyId: "ak" },
    });
    seedToken("youtube/isha");
    // no staging/default secret seeded
    const r = await diagnose();
    expect(r.ok).toBe(false);
    expect(row(r, "staging")?.status).toBe("fail");
    expect(row(r, "staging")?.detail).toContain("secret-access-key");
  });

  test("offline default reports version without network", async () => {
    healthy();
    const r = await diagnose();
    expect(row(r, "version")?.status).toBe("ok");
    expect(row(r, "version")?.detail).toContain("--online");
  });

  test("leak boundary: no secret value appears in any row", async () => {
    healthy();
    writeProfiles({
      default: "isha",
      profiles: { isha: { provider: "youtube", client_id: "cid" } },
      staging: { backend: "r2", endpoint: "https://x.r2.cloudflarestorage.com", bucket: "b", region: "auto", accessKeyId: "ak" },
    });
    seedToken("youtube/isha");
    seedToken("staging/default", { access_token: "SECRET-STAGING-KEY", refresh_token: undefined, client_secret: undefined });
    const r = await diagnose();
    const dump = JSON.stringify(r.rows);
    expect(dump).not.toContain(TEST_SECRETS.accessToken);
    expect(dump).not.toContain(TEST_SECRETS.refreshToken);
    expect(dump).not.toContain(TEST_SECRETS.clientSecret);
    expect(dump).not.toContain("SECRET-STAGING-KEY");
  });
});
