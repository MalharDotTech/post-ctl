import { existsSync, readFileSync } from "fs";
import { loadConfig, getActiveProfile } from "../config.ts";
import { getProvider, type Post } from "../provider.ts";
import { createAuthSession } from "../http.ts";
import { stageFile, type StagedMedia } from "../stage.ts";
import { ValidationError } from "../errors.ts";
import { detectFormat, printDoc } from "../output.ts";
import type { ParsedArgs } from "../args.ts";
import { stringFlag } from "../args.ts";

export function buildPost(args: ParsedArgs): Post {
  const text = args.positional[0] ?? "";

  // --description accepts a literal string or a file path (long YouTube
  // descriptions don't survive shell quoting well)
  let description = stringFlag(args.flags, "description");
  if (description && existsSync(description)) {
    description = readFileSync(description, "utf8");
  }

  const privacy = stringFlag(args.flags, "privacy");
  if (privacy && !["public", "unlisted", "private"].includes(privacy)) {
    throw new ValidationError(`--privacy must be public|unlisted|private, got '${privacy}'.`);
  }

  // Local files (--media) get staged for public-url providers; --media-url
  // entries are already hosted and skip staging entirely
  for (const path of args.media) {
    if (!existsSync(path)) throw new ValidationError(`Media file not found: ${path}`);
  }

  const tags = stringFlag(args.flags, "tags");
  return {
    text,
    media: [
      ...args.media.map((path) => ({ path })),
      ...args.mediaUrls.map((url) => ({ url })),
    ],
    link: stringFlag(args.flags, "link"),
    description,
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    privacy: privacy as Post["privacy"],
  };
}

export async function postCmd(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const post = buildPost(args);
  const format = detectFormat(stringFlag(args.flags, "output"));
  const debug = args.flags["debug"] === true;
  const dryRun = args.flags["dry-run"] === true;

  // --provider makes the offline path (--dry-run) usable pre-auth, with no
  // account configured (e2e finding 1). Real posting always resolves the
  // account and uses its provider.
  const providerFlag = stringFlag(args.flags, "provider");
  if (dryRun && providerFlag) {
    const provider = getProvider(providerFlag);
    provider.validate(post);
    printDoc({ dry_run: true, provider: provider.id, post: post as unknown as Record<string, unknown> }, format);
    return;
  }

  const { name, profile } = getActiveProfile(cfg, stringFlag(args.flags, "account"));
  const provider = getProvider(profile.provider);

  provider.validate(post);  // offline, throws ValidationError before any quota spend

  if (dryRun) {
    // Full payload preview, no sparse filtering — agents diff this
    printDoc({ dry_run: true, account: name, provider: provider.id, post: post as unknown as Record<string, unknown> }, format);
    return;
  }

  // Stage local files for providers that publish from a public URL (Meta).
  // Staged objects are cleaned up after publish; presign TTL is the backstop.
  const staged: StagedMedia[] = [];
  if (provider.capabilities.mediaSource === "public-url") {
    for (const m of post.media ?? []) {
      if (m.path && !m.url) {
        const s = await stageFile(m.path);
        m.url = s.url;
        staged.push(s);
        if (debug) console.error(`[debug] staged ${m.path} → key ${s.key}`);
      }
    }
  }

  const session = createAuthSession(provider.auth, name, profile);
  try {
    const result = await provider.post(
      { fetch: session.fetch, profileName: name, profile, debug },
      post,
    );
    printDoc({ account: name, provider: provider.id, ...result }, format);
  } finally {
    for (const s of staged) await s.cleanup();
  }
}

export function validateCmd(args: ParsedArgs): void {
  // --provider bypasses account resolution — validate is offline pre-flight
  // and must work before any auth exists (e2e finding 1)
  const providerFlag = stringFlag(args.flags, "provider");
  const provider = providerFlag
    ? getProvider(providerFlag)
    : getProvider(getActiveProfile(loadConfig(), stringFlag(args.flags, "account")).profile.provider);
  const format = detectFormat(stringFlag(args.flags, "output"));
  try {
    provider.validate(buildPost(args));
  } catch (e) {
    if (e instanceof ValidationError) {
      printDoc({ valid: false, errors: e.message.split("\n") }, format);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  printDoc({ valid: true, errors: [] }, format);
}
