// OAuth 2.0 + PKCE helpers, provider-agnostic. Ported from frappe-ctl
// (ADR-009/011): authorization code + PKCE S256, fixed-port loopback redirect.
// Endpoints come from the provider's AuthSpec — this file knows no platform.

export const REDIRECT_PORT = 8917;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;   // seconds; absent on IG short-lived tokens
  token_type?: string;
  scope?: string;
  [extra: string]: unknown;   // IG returns user_id + permissions
}

// ── PKCE crypto ────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// 48 random bytes → 64 base64url chars (within RFC 7636's 43–128 requirement)
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

// S256: base64url(sha256(ASCII(verifier)))
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64url(new Uint8Array(digest));
}

// 16 random bytes → 32 hex chars. State parameter, CSRF guard.
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Authorization URL ──────────────────────────────────────────────────────────

export function buildAuthUrl(opts: {
  authUrl: string;
  clientId: string;
  scopes: string[];
  codeChallenge?: string;   // absent for non-PKCE providers (Instagram)
  state: string;
  extraParams?: Record<string, string>;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    scope: opts.scopes.join(" "),
    state: opts.state,
    ...(opts.codeChallenge
      ? { code_challenge: opts.codeChallenge, code_challenge_method: "S256" }
      : {}),
    ...opts.extraParams,
  });
  return `${opts.authUrl}?${params}`;
}

// ── Local redirect server ──────────────────────────────────────────────────────
// Bun.serve on localhost:REDIRECT_PORT, captures the OAuth redirect, shuts
// itself down, resolves with { code, state }.

export function startLocalServer(
  port: number = REDIRECT_PORT,
  timeoutMs = 180_000,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.stop(true);
      reject(new Error(
        `OAuth timeout — no redirect received within ${timeoutMs / 1000}s.\n\n` +
        `Most likely cause: redirect URI mismatch.\n` +
        `Your OAuth client must have exactly this URI registered:\n` +
        `  http://localhost:${port}`,
      ));
    }, timeoutMs);

    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description") ?? "";

        clearTimeout(timer);
        // Defer stop so the response is fully sent before the server closes
        setTimeout(() => server.stop(true), 1000);

        if (error) {
          reject(new Error(`OAuth denied: ${error}${errorDesc ? ` — ${errorDesc}` : ""}`));
          return errorPage(`${error}${errorDesc ? `: ${errorDesc}` : ""}`);
        }

        if (!code || !state) {
          reject(new Error("OAuth redirect missing code or state parameter"));
          return errorPage("Missing code or state parameter in redirect.");
        }

        resolve({ code, state });
        return successPage();
      },
    });
  });
}

function errorPage(message: string): Response {
  return new Response(styledPage("✗", "#f85149", "Authorization Failed", message, false), {
    headers: { "Content-Type": "text/html" },
  });
}

function successPage(): Response {
  return new Response(
    styledPage("✓", "#3fb950", "Authenticated", "You may close this tab.", true),
    { headers: { "Content-Type": "text/html" } },
  );
}

function styledPage(icon: string, iconColor: string, heading: string, sub: string, autoClose: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>postctl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d1117; color: #e6edf3;
      display: flex; align-items: center; justify-content: center; height: 100vh;
    }
    .card { text-align: center; padding: 2.5rem 3rem; }
    .icon { font-size: 3.5rem; color: ${iconColor}; margin-bottom: 0.75rem; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.5rem; }
    .brand { font-size: 0.75rem; color: #8b949e; letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 1.5rem; }
    .sub { color: #8b949e; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <div class="brand">postctl</div>
    <h1>${heading}</h1>
    <p class="sub">${sub}</p>
  </div>
  ${autoClose ? `<script>setTimeout(() => window.close(), 2500)</script>` : ""}
</body>
</html>`;
}

// ── Browser launch ─────────────────────────────────────────────────────────────

export function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    Bun.spawnSync(["open", url]);
  } else if (process.platform === "linux") {
    Bun.spawnSync(["xdg-open", url]);
  } else {
    Bun.spawnSync(["cmd", "/c", "start", url]);
  }
}

// ── Token exchange / refresh ───────────────────────────────────────────────────
// Error text from these endpoints may echo request params — never include the
// raw response body together with secrets. Bodies here are safe to surface
// because client_secret/refresh_token values are never interpolated into the
// thrown message (credential-leak boundary, frappe-ctl ADR-020).

export async function exchangeCode(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier?: string;    // absent for non-PKCE providers
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
  });
  if (opts.codeVerifier) body.set("code_verifier", opts.codeVerifier);
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const res = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${scrub(text, [opts.clientSecret])}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const res = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${scrub(text, [opts.clientSecret, opts.refreshToken])}`);
  }
  return (await res.json()) as TokenResponse;
}

// Replace any secret values that a server might echo back in an error body.
function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.replaceAll(s, "[redacted]");
  }
  return out;
}
