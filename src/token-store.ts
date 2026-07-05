import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// One stored credential bundle per <provider>/<profile> key. client_secret
// rides along here (not in profiles.json) because Google installed-app
// clients require it at the token endpoint even though it's "not a secret"
// by Google's own definition — we still treat it as one.
export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;        // Unix ms — access_token expiry
  client_secret?: string;
  obtained_at: number;       // Unix ms — when this bundle was minted/refreshed
}

type TokenStore = Record<string, StoredToken>;

// Read env at call time — same isolation pattern as config.ts (ADR-004).
function tokenFile(): string {
  const dir = process.env["POSTCTL_CONFIG_DIR"]
    ?? join(process.env["HOME"] ?? "~", ".config", "postctl");
  return join(dir, "tokens.json");
}

function loadFileStore(): TokenStore {
  const f = tokenFile();
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as TokenStore;
  } catch {
    return {};
  }
}

function saveFileStore(store: TokenStore): void {
  const f = tokenFile();
  const dir = join(f, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
}

// ── macOS Keychain ─────────────────────────────────────────────────────────────
// Uses `security` CLI (built into macOS, zero deps).

function keychainKey(key: string): string {
  return `postctl:${key}`;
}

function keychainSave(key: string, value: string): boolean {
  if (process.platform !== "darwin") return false;
  if (process.env["POSTCTL_NO_KEYCHAIN"] === "1") return false;
  const result = Bun.spawnSync([
    "security", "add-generic-password",
    "-a", "postctl",
    "-s", keychainKey(key),
    "-w", value,
    "-U",
  ]);
  if (result.exitCode !== 0) {
    // Keychain attempted and failed — warn rather than silently degrade to a
    // less-protected file store (gh CLI shipped this failure mode, cli/cli#8954).
    console.error(
      "Warning: macOS Keychain write failed — falling back to file storage at ~/.config/postctl/tokens.json. Set POSTCTL_NO_KEYCHAIN=1 to suppress this warning.",
    );
    return false;
  }
  return true;
}

function keychainLoad(key: string): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env["POSTCTL_NO_KEYCHAIN"] === "1") return null;
  const result = Bun.spawnSync([
    "security", "find-generic-password",
    "-a", "postctl",
    "-s", keychainKey(key),
    "-w",
  ]);
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim() || null;
}

function keychainDelete(key: string): void {
  if (process.platform !== "darwin") return;
  if (process.env["POSTCTL_NO_KEYCHAIN"] === "1") return;
  Bun.spawnSync([
    "security", "delete-generic-password",
    "-a", "postctl",
    "-s", keychainKey(key),
  ]);
}

// ── Public API ─────────────────────────────────────────────────────────────────
// key = "<provider>/<profile>", e.g. "youtube/isha"

export function saveToken(key: string, token: StoredToken): void {
  const value = JSON.stringify(token);
  if (keychainSave(key, value)) return;
  const store = loadFileStore();
  store[key] = token;
  saveFileStore(store);
}

export function loadToken(key: string): StoredToken | null {
  const raw = keychainLoad(key);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      // corrupt keychain entry — fall through to file store
    }
  }
  const store = loadFileStore();
  return store[key] ?? null;
}

export function deleteToken(key: string): void {
  keychainDelete(key);
  const store = loadFileStore();
  delete store[key];
  saveFileStore(store);
}

export function isTokenExpired(token: StoredToken, bufferMs = 300_000): boolean {
  // Expired if within bufferMs (5 min) of actual expiry — proactive refresh window
  return Date.now() >= token.expires_at - bufferMs;
}
