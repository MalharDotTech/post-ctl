import { loadConfig, upsertProfile, getActiveProfile } from "../config.ts";
import { getProvider } from "../provider.ts";
import { createAuthSession } from "../http.ts";
import { loadToken, saveToken, deleteToken } from "../token-store.ts";
import { AuthRequiredError, ValidationError } from "../errors.ts";
import { detectFormat, printDoc, printDocs } from "../output.ts";
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  buildAuthUrl, startLocalServer, openBrowser, exchangeCode, REDIRECT_PORT, REDIRECT_URI,
} from "../oauth.ts";
import type { ParsedArgs } from "../args.ts";
import { stringFlag } from "../args.ts";

export async function authLogin(args: ParsedArgs): Promise<void> {
  const providerId = args.positional[0];
  if (!providerId) {
    throw new ValidationError("Usage: postctl auth login <provider> --account <name> [--client-id … --client-secret …]");
  }
  const provider = getProvider(providerId);
  const spec = provider.auth;
  const account = stringFlag(args.flags, "account") ?? providerId;

  // client_id: flag > existing profile. Never prompt — agents can't answer.
  const cfg = loadConfig();
  const existing = cfg.profiles[account];
  const clientId = stringFlag(args.flags, "client-id") ?? existing?.client_id;
  if (!clientId) {
    throw new ValidationError(
      `No OAuth client for account '${account}'.\n` +
      `Run: postctl auth login ${providerId} --account ${account} --client-id <id>` +
      (spec.clientSecretRequired ? " --client-secret <secret>" : "") +
      `\nSetup guide: docs/platforms/${providerId}.md`,
    );
  }
  const storedSecret = loadToken(`${spec.providerId}/${account}`)?.client_secret;
  const clientSecret = stringFlag(args.flags, "client-secret") ?? storedSecret;
  if (spec.clientSecretRequired && !clientSecret) {
    throw new ValidationError(
      `Provider '${providerId}' requires --client-secret (installed-app OAuth client).`,
    );
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const url = buildAuthUrl({
    authUrl: spec.authUrl,
    clientId,
    scopes: spec.scopes,
    codeChallenge: challenge,
    state,
    extraParams: spec.authExtraParams,
  });

  console.error(`Opening browser for ${providerId} authorization…`);
  console.error(`If it doesn't open, visit:\n  ${url}\n`);
  console.error(`Note: your OAuth client must have redirect URI ${REDIRECT_URI} registered.`);
  const pending = startLocalServer(REDIRECT_PORT);
  openBrowser(url);
  const { code, state: returnedState } = await pending;
  if (returnedState !== state) {
    throw new AuthRequiredError("OAuth state mismatch — possible CSRF, aborting.");
  }

  const tokens = await exchangeCode({
    tokenUrl: spec.tokenUrl,
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
  });
  if (spec.refresh === "standard" && !tokens.refresh_token) {
    throw new AuthRequiredError(
      "No refresh_token in response. For Google: the OAuth consent screen must be in Production " +
      "(Testing-mode refresh tokens die after 7 days), and access was likely granted before — " +
      "revoke the app at myaccount.google.com/permissions and log in again.",
    );
  }

  saveToken(`${spec.providerId}/${account}`, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    client_secret: clientSecret,
    obtained_at: Date.now(),
  });
  upsertProfile(account, { provider: providerId, client_id: clientId });

  // Cache channel identity on the profile — makes 'accounts list' meaningful
  const session = createAuthSession(spec, account, { provider: providerId, client_id: clientId });
  const info = await provider.verify({ fetch: session.fetch, profileName: account, profile: session.profile, debug: false });
  upsertProfile(account, { provider: providerId, client_id: clientId, channel_id: info.id, channel_title: info.displayName });

  printDoc(
    { account, provider: providerId, channel: info.displayName ?? info.username, channel_id: info.id, status: "authenticated" },
    detectFormat(stringFlag(args.flags, "output")),
  );
}

export function authStatus(args: ParsedArgs): void {
  const cfg = loadConfig();
  const only = stringFlag(args.flags, "account");
  const names = only ? [only] : Object.keys(cfg.profiles);
  const rows = names.map((name) => {
    const p = cfg.profiles[name];
    if (!p) return { account: name, status: "unknown account" };
    const token = loadToken(`${p.provider}/${name}`);
    if (!token) {
      return { account: name, provider: p.provider, channel: p.channel_title ?? "", status: "no token — run auth login" };
    }
    const spec = getProvider(p.provider).auth;
    const accessExpiresMin = Math.round((token.expires_at - Date.now()) / 60_000);
    const refreshable = Boolean(token.refresh_token) && spec.refresh !== "reauth" && spec.refresh !== "none";
    return {
      account: name,
      provider: p.provider,
      channel: p.channel_title ?? "",
      status: refreshable ? "ok (auto-refresh)" : accessExpiresMin > 0 ? "ok (no refresh)" : "expired — run auth login",
      access_expires_in_min: accessExpiresMin,
      default: cfg.default === name || undefined,
    };
  });
  printDocs(rows, detectFormat(stringFlag(args.flags, "output")));
}

export function authLogout(args: ParsedArgs): void {
  const cfg = loadConfig();
  const { name, profile } = getActiveProfile(cfg, stringFlag(args.flags, "account"));
  deleteToken(`${profile.provider}/${name}`);
  console.log(`Token for '${name}' deleted.`);
}
