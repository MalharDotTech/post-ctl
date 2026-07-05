import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestConfigDir, teardownTestConfigDir, makeTempVideo, TEST_SECRETS,
} from "./__fixtures__/test-helpers.ts";

// End-to-end exit-code contract (ADR-022): spawn the real CLI.
// 0 success | 1 validation/API failure | 4 auth required

const CLI = join(import.meta.dir, "cli.ts");

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

function run(args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, POSTCTL_CONFIG_DIR: dir, POSTCTL_NO_KEYCHAIN: "1" },
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function seedAccount(): void {
  writeFileSync(join(dir, "profiles.json"), JSON.stringify({
    default: "isha",
    profiles: { isha: { provider: "youtube", client_id: "cid" } },
  }));
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({
    "youtube/isha": {
      access_token: TEST_SECRETS.accessToken,
      refresh_token: TEST_SECRETS.refreshToken,
      expires_at: Date.now() + 3600_000,
      obtained_at: Date.now(),
    },
  }));
}

describe("cli exit-code contract", () => {
  test("--help exits 0", () => {
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("postctl");
    expect(r.stdout).toContain("Exit codes");
  });

  test("--version prints version, exits 0", () => {
    const r = run(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("unknown verb exits 1", () => {
    const r = run(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown verb");
  });

  test("no account configured exits 4", () => {
    const r = run(["post", "hello"]);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("auth required");
  });

  test("validate failure exits 1 with structured JSON", () => {
    seedAccount();
    const r = run(["validate", "title", "--output", "json"]);  // no --media
    expect(r.exitCode).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.valid).toBe(false);
    expect(doc.errors.join(" ")).toContain("--media");
  });

  test("validate success exits 0", () => {
    seedAccount();
    const video = makeTempVideo(dir);
    const r = run(["validate", "A title", "--media", video, "--output", "json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ valid: true, errors: [] });
  });

  test("post --dry-run prints full payload, no network, exits 0", () => {
    seedAccount();
    const video = makeTempVideo(dir);
    const r = run([
      "post", "A title", "--media", video, "--description", "desc",
      "--tags", "a, b", "--privacy", "private", "--dry-run", "--output", "json",
    ]);
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dry_run).toBe(true);
    expect(doc.provider).toBe("youtube");
    expect(doc.post.text).toBe("A title");
    expect(doc.post.tags).toEqual(["a", "b"]);
    expect(doc.post.privacy).toBe("private");
  });

  test("auth status shows account with refreshable token, exits 0", () => {
    seedAccount();
    const r = run(["auth", "status", "--output", "json"]);
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows[0].account).toBe("isha");
    expect(rows[0].status).toContain("auto-refresh");
    // Dashboard never prints token values
    expect(r.stdout).not.toContain(TEST_SECRETS.accessToken);
    expect(r.stdout).not.toContain(TEST_SECRETS.refreshToken);
  });

  test("accounts list exits 0", () => {
    seedAccount();
    const r = run(["accounts", "list", "--output", "json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)[0].account).toBe("isha");
  });

  test("auth login without client-id exits 1 naming the flag", () => {
    const r = run(["auth", "login", "youtube", "--account", "new"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--client-id");
  });
});
