import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config.ts";
import { PROVIDERS } from "../provider.ts";
import { loadToken, isTokenExpired } from "../token-store.ts";
import { STAGING_SECRET_KEY } from "../stage.ts";
import { detectFormat, printDocs } from "../output.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { VERSION } from "../version.ts";

const REPO = "MalharDotTech/post-ctl";

// One diagnostic row. status drives the exit code; fix is the exact command
// to run when a check fails (empty on ok/warn-with-no-action).
export interface DoctorRow {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string;
}

export interface DoctorReport {
  rows: DoctorRow[];
  ok: boolean;   // false if any row is "fail"
}

function configDir(): string {
  return process.env["POSTCTL_CONFIG_DIR"] ?? join(process.env["HOME"] ?? "~", ".config", "postctl");
}

// Where does this profile's token physically live? tokens.json is the file
// fallback; anything else present is keychain (macOS). Mirrors token-store.ts
// load order without exposing its internals.
function tokenBackend(key: string): "file" | "keychain" | "none" {
  const file = join(configDir(), "tokens.json");
  if (existsSync(file)) {
    try {
      const store = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (store[key]) return "file";
    } catch { /* corrupt file — fall through */ }
  }
  return loadToken(key) ? "keychain" : "none";
}

// Pure diagnosis over config/token-store state. Offline unless online=true,
// in which case it also queries the GitHub Releases API for the latest tag.
export async function diagnose(opts: { online?: boolean } = {}): Promise<DoctorReport> {
  const rows: DoctorRow[] = [];
  const push = (r: DoctorRow) => rows.push(r);

  // ── config dir + profiles.json ──────────────────────────────────────────
  const dir = configDir();
  const profilesFile = join(dir, "profiles.json");
  if (!existsSync(dir)) {
    push({ check: "config-dir", status: "fail", detail: `${dir} missing`, fix: "postctl setup youtube" });
  } else {
    push({ check: "config-dir", status: "ok", detail: dir, fix: "" });
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    push({ check: "profiles.json", status: "fail", detail: `${profilesFile} unparseable`, fix: "postctl setup youtube" });
    return { rows, ok: false };
  }

  const names = Object.keys(cfg.profiles);
  if (names.length === 0) {
    push({ check: "profiles", status: "fail", detail: "no accounts configured", fix: "postctl setup youtube" });
  } else {
    push({ check: "profiles", status: "ok", detail: `${names.length} account(s); default=${cfg.default || "(none)"}`, fix: "" });
  }

  // ── per-profile checks ──────────────────────────────────────────────────
  for (const name of names) {
    const p = cfg.profiles[name]!;
    const spec = PROVIDERS[p.provider]?.auth;
    if (!spec) {
      push({ check: `${name}: provider`, status: "fail", detail: `unknown provider '${p.provider}'`, fix: `postctl accounts remove ${name}` });
      continue;
    }
    const key = `${p.provider}/${name}`;
    const token = loadToken(key);
    if (!token) {
      push({ check: `${name}: token`, status: "fail", detail: "no stored token", fix: `postctl auth login ${p.provider} --account ${name}` });
      continue;
    }

    // refresh token — required only for the standard grant (Meta uses long-lived
    // exchange, no refresh_token; reauth/none providers never carry one).
    if (spec.refresh === "standard" && !token.refresh_token) {
      push({ check: `${name}: refresh-token`, status: "fail", detail: "missing (consent screen in Testing, or app pre-authorized)", fix: `postctl auth login ${p.provider} --account ${name}` });
    }

    const mins = Math.round((token.expires_at - Date.now()) / 60_000);
    const refreshable = Boolean(token.refresh_token) && spec.refresh !== "reauth" && spec.refresh !== "none";
    if (isTokenExpired(token) && !refreshable) {
      push({ check: `${name}: token-expiry`, status: "fail", detail: `expired ${-mins} min ago, no refresh`, fix: `postctl auth login ${p.provider} --account ${name}` });
    } else {
      push({ check: `${name}: token-expiry`, status: "ok", detail: refreshable ? `${mins} min (auto-refresh)` : `${mins} min`, fix: "" });
    }

    // storage backend + file permission
    const backend = tokenBackend(key);
    if (backend === "file") {
      const mode = statSync(join(dir, "tokens.json")).mode & 0o777;
      if (mode !== 0o600) {
        push({ check: `${name}: token-perms`, status: "fail", detail: `tokens.json is ${mode.toString(8).padStart(4, "0")}, want 0600`, fix: `chmod 600 ${join(dir, "tokens.json")}` });
      } else {
        push({ check: `${name}: storage`, status: "ok", detail: "file (0600)", fix: "" });
      }
    } else {
      push({ check: `${name}: storage`, status: "ok", detail: backend, fix: "" });
    }
  }

  // ── staging (only if configured) ────────────────────────────────────────
  if (cfg.staging && cfg.staging.backend !== "none") {
    const s = cfg.staging;
    const missing: string[] = [];
    if (!s.endpoint) missing.push("endpoint");
    if (!s.bucket) missing.push("bucket");
    if (!s.accessKeyId) missing.push("access-key-id");
    const secret = loadToken(STAGING_SECRET_KEY)?.access_token;
    if (!secret) missing.push("secret-access-key");
    if (missing.length) {
      push({ check: "staging", status: "fail", detail: `incomplete: missing ${missing.join(", ")}`, fix: "postctl staging set --endpoint … --bucket … --access-key-id … --secret-access-key …" });
    } else {
      push({ check: "staging", status: "ok", detail: `${s.backend} ${s.bucket}`, fix: "" });
    }
  }

  // ── version ─────────────────────────────────────────────────────────────
  if (opts.online) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "postctl-doctor" },
      });
      if (res.ok) {
        const latest = ((await res.json()) as { tag_name?: string }).tag_name?.replace(/^v/, "") ?? "";
        if (latest && latest !== VERSION) {
          push({ check: "version", status: "warn", detail: `installed ${VERSION}, latest ${latest}`, fix: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh` });
        } else {
          push({ check: "version", status: "ok", detail: `${VERSION} (latest)`, fix: "" });
        }
      } else {
        push({ check: "version", status: "warn", detail: `${VERSION} (latest-check failed: HTTP ${res.status})`, fix: "" });
      }
    } catch {
      push({ check: "version", status: "warn", detail: `${VERSION} (offline — could not check latest)`, fix: "" });
    }
  } else {
    push({ check: "version", status: "ok", detail: `${VERSION} (run with --online to check for updates)`, fix: "" });
  }

  return { rows, ok: !rows.some((r) => r.status === "fail") };
}

export async function doctorCmd(args: ParsedArgs): Promise<void> {
  const online = args.flags["online"] === true;
  const report = await diagnose({ online });
  printDocs(report.rows as unknown as Record<string, unknown>[], detectFormat(stringFlag(args.flags, "output")));
  // validateCmd precedent (ADR-022): a diagnostic command owns its exit code.
  if (!report.ok) process.exitCode = 1;
}
