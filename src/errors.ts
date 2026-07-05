// Error taxonomy → exit-code contract (frappe-ctl ADR-022 carried forward):
//   0 success | 1 validation/API failure | 4 auth required
// cli.ts maps error classes to exit codes; nothing else calls process.exit.

// Missing profile, expired non-refreshable token, HTTP 401, refresh failure.
// LinkedIn's 60-day wall and Google's revoked-consent both land here. Agents
// branch on exit 4 and run the printed command.
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

// Offline pre-flight failure (missing media, title too long, bad format).
// Never costs quota — thrown before any network call.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Platform API rejected the request (4xx other than 401, or 5xx after
// bounded retries). Message must already be credential-scrubbed by http.ts —
// this class is safe to print.
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
