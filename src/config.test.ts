import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig, upsertProfile, getActiveProfile, removeProfile } from "./config.ts";
import { AuthRequiredError } from "./errors.ts";
import { setupTestConfigDir, teardownTestConfigDir } from "./__fixtures__/test-helpers.ts";
import { statSync } from "fs";
import { join } from "path";

let dir: string;
beforeEach(() => { dir = setupTestConfigDir(); });
afterEach(() => { teardownTestConfigDir(dir); });

describe("config", () => {
  test("empty config when no file", () => {
    expect(loadConfig()).toEqual({ default: "", profiles: {} });
  });

  test("upsert sets first profile as default", () => {
    upsertProfile("isha", { provider: "youtube", client_id: "cid" });
    const cfg = loadConfig();
    expect(cfg.default).toBe("isha");
    expect(cfg.profiles["isha"]!.provider).toBe("youtube");
  });

  test("upsert merges instead of clobbering", () => {
    upsertProfile("isha", { provider: "youtube", client_id: "cid" });
    upsertProfile("isha", { provider: "youtube", channel_title: "Isha" });
    expect(loadConfig().profiles["isha"]).toEqual({
      provider: "youtube", client_id: "cid", channel_title: "Isha",
    });
  });

  test("getActiveProfile throws AuthRequiredError with no default", () => {
    expect(() => getActiveProfile(loadConfig())).toThrow(AuthRequiredError);
  });

  test("getActiveProfile resolves override", () => {
    upsertProfile("a", { provider: "youtube" });
    upsertProfile("b", { provider: "youtube" });
    expect(getActiveProfile(loadConfig(), "b").name).toBe("b");
    expect(getActiveProfile(loadConfig()).name).toBe("a");
  });

  test("removeProfile reassigns default", () => {
    upsertProfile("a", { provider: "youtube" });
    upsertProfile("b", { provider: "youtube" });
    removeProfile("a");
    expect(loadConfig().default).toBe("b");
  });

  test("profiles.json written 0o600", () => {
    upsertProfile("isha", { provider: "youtube" });
    const mode = statSync(join(dir, "profiles.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
