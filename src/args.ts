// Minimal argv parser — zero deps. Value flags consume the next token
// (or inline =); boolean flags don't. --media is repeatable.

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  media: string[];
  mediaUrls: string[];
}

const BOOLEAN_FLAGS = new Set(["debug", "dry-run", "help", "version", "readonly", "online"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const media: string[] = [];
  const mediaUrls: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value: string | boolean;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (BOOLEAN_FLAGS.has(name)) {
      value = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;  // value flag used bare — treat as boolean, verb validates
      } else {
        value = next;
        i++;
      }
    }
    if (name === "media" && typeof value === "string") {
      media.push(value);
    } else if (name === "media-url" && typeof value === "string") {
      mediaUrls.push(value);
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags, media, mediaUrls };
}

export function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
