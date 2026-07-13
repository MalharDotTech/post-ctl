import { loadConfig } from "../config.ts";
import { loadToken, isTokenExpired } from "../token-store.ts";
import { getProvider, PROVIDERS } from "../provider.ts";
import { ValidationError } from "../errors.ts";
import { REDIRECT_URI } from "../oauth.ts";
import { authLogin } from "./auth.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";

// `postctl setup <provider>` — guided, validating, resumable onboarding.
// TTY-gated: agents (non-TTY) get the manual non-interactive path; humans get
// the wizard. Step *logic* (validation, state derivation, copy) is pure and
// unit-tested; only prompt I/O touches the terminal.

const SUPPORTED = ["youtube"];  // grows as providers gain wizard copy

// ── pure: input validation ─────────────────────────────────────────────────

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function isValidClientId(id: string): boolean {
  const t = id.trim();
  return t.length > CLIENT_ID_SUFFIX.length && t.endsWith(CLIENT_ID_SUFFIX);
}

export function isValidClientSecret(secret: string): boolean {
  return secret.trim().length > 0;
}

// ── pure: resumable state derivation ────────────────────────────────────────
// project → api → consent → client are one-time console steps we always show;
// the *account* stage below decides where credential collection resumes.

export type SetupStage = "collect-client" | "collect-secret" | "login" | "verify";

export function deriveSetupState(providerId: string, account: string): { stage: SetupStage; clientId?: string } {
  const cfg = loadConfig();
  const profile = cfg.profiles[account];
  const token = loadToken(`${providerId}/${account}`);
  const spec = PROVIDERS[providerId]?.auth;

  const refreshable = token ? Boolean(token.refresh_token) && spec?.refresh !== "reauth" && spec?.refresh !== "none" : false;
  if (token && (!isTokenExpired(token) || refreshable)) {
    return { stage: "verify", clientId: profile?.client_id };
  }
  if (profile?.client_id) {
    const hasSecret = Boolean(token?.client_secret);
    return { stage: hasSecret ? "login" : "collect-secret", clientId: profile.client_id };
  }
  return { stage: "collect-client" };
}

// ── pure: console-step copy (source: docs/platforms/youtube.md) ─────────────

export interface ConsoleStep { title: string; url: string; note?: string; }

export function youtubeConsoleSteps(): ConsoleStep[] {
  return [
    { title: "Create a Google Cloud project (e.g. isha-postctl)", url: "https://console.cloud.google.com/projectcreate" },
    { title: "Enable the YouTube Data API v3 for that project", url: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" },
    {
      title: "Configure the OAuth consent screen",
      url: "https://console.cloud.google.com/apis/credentials/consent",
      note:
        "User type External · scopes youtube.upload + youtube.readonly · PUBLISH TO PRODUCTION.\n" +
        "  ⚠  Do NOT leave it in Testing mode — Testing-mode refresh tokens die after 7 days.\n" +
        "     The 'app requires verification' warning is fine to skip for team use (100-user cap).",
    },
    {
      title: "Create an OAuth client ID of type Desktop app",
      url: "https://console.cloud.google.com/apis/credentials",
      note: `Desktop clients accept any localhost redirect automatically (${REDIRECT_URI}); nothing to register.`,
    },
  ];
}

export function testPostCommand(account: string): string {
  return `postctl post "My first video" --media ./clip.mp4 --account ${account} --dry-run`;
}

// ── prompt I/O (terminal only; not exercised in unit tests) ─────────────────

function ask(promptText: string): string {
  // Bun's global prompt() reads a line from stdin (echoed — non-secret only).
  const v = prompt(promptText);
  if (v === null) throw new ValidationError("Setup aborted (end of input).");
  return v.trim();
}

// Read a secret with terminal echo disabled. Never echoes, never prints back.
async function askSecret(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => {
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf));
        if (ch === "\x03") return done(() => reject(new ValidationError("Setup aborted.")));  // Ctrl-C
        if (ch === "\x7f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ── command entry ───────────────────────────────────────────────────────────

export async function setupCmd(args: ParsedArgs): Promise<void> {
  const providerId = args.positional[0];
  if (!providerId) {
    throw new ValidationError(`Usage: postctl setup <provider>\nSupported: ${SUPPORTED.join(", ")}`);
  }
  if (!SUPPORTED.includes(providerId)) {
    throw new ValidationError(`Setup wizard not available for '${providerId}'. Supported: ${SUPPORTED.join(", ")}`);
  }
  const account = stringFlag(args.flags, "account") ?? providerId;

  // Non-TTY (agents, pipes): refuse cleanly with the manual path. Not the write
  // path, but the wizard cannot prompt without a terminal.
  if (!process.stdin.isTTY) {
    throw new ValidationError(
      `setup is interactive and needs a terminal (stdin is not a TTY).\n` +
      `Manual guide: docs/platforms/${providerId}.md\n` +
      `Non-interactive setup:\n` +
      `  postctl auth login ${providerId} --account ${account} --client-id <ID> --client-secret <SECRET>`,
    );
  }

  const e = (s: string) => process.stderr.write(s + "\n");
  e(`\npostctl setup ${providerId} → account '${account}'\n`);

  let state = deriveSetupState(providerId, account);

  // Steps 1–4: one-time Google Cloud console setup (skip if we already have a
  // client_id on the profile — resuming a partial setup).
  if (state.stage === "collect-client") {
    e("One-time Google Cloud setup (admin, ~5 min). Complete each, then press Enter:\n");
    const steps = youtubeConsoleSteps();
    steps.forEach((s, i) => {
      e(`  ${i + 1}. ${s.title}\n     ${s.url}`);
      if (s.note) e(`     ${s.note}`);
      ask("     [Enter when done] ");
      e("");
    });
  } else {
    e(`✓ OAuth client already on profile '${account}' — skipping console setup.\n`);
  }

  // Step 5: client ID
  let clientId = state.clientId;
  if (state.stage === "collect-client") {
    for (;;) {
      clientId = ask("Paste the OAuth client ID: ");
      if (isValidClientId(clientId)) break;
      e(`  ✗ Expected an ID ending in ${CLIENT_ID_SUFFIX}. Try again.`);
    }
  }

  // Step 6: client secret (echo disabled). Skipped if a secret is already stored.
  let clientSecret: string | undefined;
  if (state.stage === "collect-client" || state.stage === "collect-secret") {
    for (;;) {
      clientSecret = await askSecret("Paste the OAuth client secret (input hidden): ");
      if (isValidClientSecret(clientSecret)) break;
      e("  ✗ Secret cannot be empty. Try again.");
    }
  }

  // Step 7: browser OAuth — reuse authLogin (it stores tokens, upserts the
  // profile, and prints the verified channel). Skip if we already have a live
  // token (resume → verify only).
  if (state.stage !== "verify") {
    e("\nOpening browser for Google authorization…");
    const loginArgs: ParsedArgs = {
      positional: [providerId],
      flags: {
        account,
        ...(clientId ? { "client-id": clientId } : {}),
        ...(clientSecret ? { "client-secret": clientSecret } : {}),
      },
      media: [],
      mediaUrls: [],
    };
    await authLogin(loginArgs);  // prints account/channel on success
  } else {
    e(`✓ Live token for '${account}' — verifying channel…`);
    const provider = getProvider(providerId);
    const cfg = loadConfig();
    const profile = cfg.profiles[account]!;
    const { createAuthSession } = await import("../http.ts");
    const session = createAuthSession(provider.auth, account, profile);
    const info = await provider.verify({ fetch: session.fetch, profileName: account, profile, debug: false });
    e(`  channel: ${info.displayName ?? info.username} (${info.id})`);
  }

  // Step 9: copyable test command
  e("\n✓ Setup complete. Try a no-cost dry run:\n");
  e(`  ${testPostCommand(account)}\n`);
}
