import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { AuthRequiredError } from "./errors.ts";

// A profile is one named account on one provider, e.g. "isha" → youtube.
// Secrets (client_secret, tokens) never live here — token-store.ts owns them.
export interface Profile {
  provider: string;          // provider id, e.g. "youtube"
  client_id?: string;        // OAuth client ID — saved by 'auth login'
  channel_id?: string;       // provider-side account identity, cached by verify
  channel_title?: string;
}

export interface Config {
  default: string;
  profiles: Record<string, Profile>;
}

// Read env var at call time (not module load time) so tests can inject via
// POSTCTL_CONFIG_DIR — frappe-ctl ADR-004, test isolation depends on this.
function configDir(): string {
  return process.env["POSTCTL_CONFIG_DIR"] ?? join(process.env["HOME"] ?? "~", ".config", "postctl");
}
function configFile(): string {
  return join(configDir(), "profiles.json");
}

function emptyConfig(): Config {
  return { default: "", profiles: {} };
}

export function loadConfig(): Config {
  if (!existsSync(configFile())) return emptyConfig();
  try {
    return JSON.parse(readFileSync(configFile(), "utf8")) as Config;
  } catch {
    return emptyConfig();
  }
}

export function saveConfig(cfg: Config): void {
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
}

export function getActiveProfile(cfg: Config, override?: string): { name: string; profile: Profile } {
  const name = override ?? cfg.default;
  if (!name) {
    throw new AuthRequiredError(
      "No account configured. Run: postctl auth login <provider> --account <name>",
    );
  }
  const profile = cfg.profiles[name];
  if (!profile) {
    throw new AuthRequiredError(`Account '${name}' not found. Run: postctl accounts list`);
  }
  return { name, profile };
}

export function upsertProfile(name: string, profile: Profile): void {
  const cfg = loadConfig();
  cfg.profiles[name] = { ...cfg.profiles[name], ...profile };
  if (!cfg.default) cfg.default = name;
  saveConfig(cfg);
}

export function removeProfile(name: string): void {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) throw new Error(`Account '${name}' not found.`);
  delete cfg.profiles[name];
  if (cfg.default === name) {
    cfg.default = Object.keys(cfg.profiles)[0] ?? "";
  }
  saveConfig(cfg);
}
