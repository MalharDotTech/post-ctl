#!/usr/bin/env bun
import { parseArgs } from "./args.ts";
import { AuthRequiredError, ValidationError, ApiError } from "./errors.ts";
import { authLogin, authStatus, authLogout } from "./commands/auth.ts";
import { postCmd, validateCmd } from "./commands/post.ts";
import { accountsCmd } from "./commands/accounts.ts";
import { PROVIDERS } from "./provider.ts";

const VERSION = "0.1.0";  // keep in sync with package.json (freshness test)

const HELP = `postctl ${VERSION} — social posting for humans and AI agents

Usage: postctl [--account <name>] <verb> [args] [flags]

Verbs:
  auth login <provider>    Authenticate an account (--account, --client-id, --client-secret)
  auth status              Per-account token dashboard (offline)
  auth logout              Delete stored token (--account)
  accounts list            List configured accounts
  accounts use <name>      Set default account
  accounts remove <name>   Remove account + token
  post "<text>"            Publish (--media, --description, --tags, --privacy, --dry-run)
  validate "<text>"        Offline pre-flight, no quota spend (--media, …)
  providers                List available providers

Flags:
  --account <name>   Target account (default: configured default)
  --output json|table
  --dry-run          Print exact payload, no network
  --debug            Verbose to stderr; never prints secret values
  --help, --version

Exit codes: 0 success | 1 validation/API failure | 4 auth required
Providers: ${Object.keys(PROVIDERS).join(", ")}
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags["version"] === true) {
    console.log(VERSION);
    return;
  }
  if (args.flags["help"] === true || args.positional.length === 0) {
    console.log(HELP);
    return;
  }

  const verb = args.positional.shift()!;

  switch (verb) {
    case "auth": {
      const sub = args.positional.shift();
      if (sub === "login") return authLogin(args);
      if (sub === "status") return authStatus(args);
      if (sub === "logout") return authLogout(args);
      throw new ValidationError(`Unknown subcommand 'auth ${sub ?? ""}'. Use: login | status | logout`);
    }
    case "accounts":
      return accountsCmd(args);
    case "post":
      return postCmd(args);
    case "validate":
      return validateCmd(args);
    case "providers":
      console.log(Object.keys(PROVIDERS).join("\n"));
      return;
    default:
      throw new ValidationError(`Unknown verb '${verb}'. Run: postctl --help`);
  }
}

try {
  await main();
} catch (e) {
  // Error class → exit code mapping (ADR-022). Messages are already
  // credential-scrubbed at the boundary where they're thrown.
  if (e instanceof AuthRequiredError) {
    console.error(`auth required: ${e.message}`);
    process.exitCode = 4;
  } else if (e instanceof ValidationError) {
    console.error(`validation failed:\n${e.message}`);
    process.exitCode = 1;
  } else if (e instanceof ApiError) {
    console.error(`api error: ${e.message}`);
    process.exitCode = 1;
  } else {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
