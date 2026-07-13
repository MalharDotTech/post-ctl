import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  isValidClientId, isValidClientSecret, deriveSetupState,
  youtubeConsoleSteps, testPostCommand,
} from "./setup.ts";
import {
  setupTestConfigDir, teardownTestConfigDir, seedToken, TEST_SECRETS,
} from "../__fixtures__/test-helpers.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
const GOOD_ID = "123456789-abcdef.apps.googleusercontent.com";

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

function writeProfiles(cfg: unknown): void {
  writeFileSync(join(dir, "profiles.json"), JSON.stringify(cfg));
}

describe("setup input validation", () => {
  test("client ID must end in .apps.googleusercontent.com", () => {
    expect(isValidClientId(GOOD_ID)).toBe(true);
    expect(isValidClientId("  " + GOOD_ID + "  ")).toBe(true);
    expect(isValidClientId("not-an-id")).toBe(false);
    expect(isValidClientId(".apps.googleusercontent.com")).toBe(false);
    expect(isValidClientId("")).toBe(false);
  });

  test("client secret must be non-empty", () => {
    expect(isValidClientSecret("GOCSPX-x")).toBe(true);
    expect(isValidClientSecret("   ")).toBe(false);
    expect(isValidClientSecret("")).toBe(false);
  });
});

describe("setup resumable state", () => {
  test("no profile → collect-client", () => {
    expect(deriveSetupState("youtube", "isha").stage).toBe("collect-client");
  });

  test("client_id but no token → collect-secret", () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: GOOD_ID } } });
    const s = deriveSetupState("youtube", "isha");
    expect(s.stage).toBe("collect-secret");
    expect(s.clientId).toBe(GOOD_ID);
  });

  test("client_id + expired token with stored secret → login", () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: GOOD_ID } } });
    seedToken("youtube/isha", { expires_at: Date.now() - 60_000, refresh_token: undefined });
    expect(deriveSetupState("youtube", "isha").stage).toBe("login");
  });

  test("client_id + expired token without stored secret → collect-secret", () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: GOOD_ID } } });
    seedToken("youtube/isha", { expires_at: Date.now() - 60_000, refresh_token: undefined, client_secret: undefined });
    expect(deriveSetupState("youtube", "isha").stage).toBe("collect-secret");
  });

  test("valid refreshable token → verify", () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: GOOD_ID } } });
    seedToken("youtube/isha");  // valid + refresh_token
    expect(deriveSetupState("youtube", "isha").stage).toBe("verify");
  });
});

describe("setup console copy", () => {
  test("consent step carries the Production/Testing warning", () => {
    const steps = youtubeConsoleSteps();
    const consent = steps.find((s) => s.title.toLowerCase().includes("consent"));
    expect(consent?.note).toContain("PRODUCTION");
    expect(consent?.note).toContain("7 days");
  });

  test("desktop-client step names the localhost redirect", () => {
    const steps = youtubeConsoleSteps();
    const client = steps.find((s) => s.title.toLowerCase().includes("desktop"));
    expect(client?.note).toContain("localhost:8917");
  });

  test("test command is a dry-run for the account", () => {
    expect(testPostCommand("isha")).toContain("--dry-run");
    expect(testPostCommand("isha")).toContain("--account isha");
  });
});

describe("setup leak boundary", () => {
  test("state derivation never surfaces the stored client_secret", () => {
    writeProfiles({ default: "isha", profiles: { isha: { provider: "youtube", client_id: GOOD_ID } } });
    seedToken("youtube/isha", { expires_at: Date.now() - 60_000, refresh_token: undefined });
    const dump = JSON.stringify(deriveSetupState("youtube", "isha"));
    expect(dump).not.toContain(TEST_SECRETS.clientSecret);
    expect(dump).not.toContain(TEST_SECRETS.accessToken);
    expect(dump).not.toContain(TEST_SECRETS.refreshToken);
  });
});

describe("setup TTY gating (spawned)", () => {
  function run(args: string[]) {
    const proc = Bun.spawnSync(["bun", CLI, ...args], {
      env: { ...process.env, POSTCTL_CONFIG_DIR: dir, POSTCTL_NO_KEYCHAIN: "1" },
      stdin: "ignore",  // no TTY
    });
    return {
      exitCode: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  test("non-TTY setup exits 1 with the manual path", () => {
    const r = run(["setup", "youtube"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("docs/platforms/youtube.md");
    expect(r.stderr).toContain("auth login youtube");
  });

  test("unknown provider exits 1", () => {
    const r = run(["setup", "myspace"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Supported: youtube");
  });
});
