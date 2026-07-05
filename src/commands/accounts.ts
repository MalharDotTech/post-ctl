import { loadConfig, saveConfig, removeProfile } from "../config.ts";
import { deleteToken } from "../token-store.ts";
import { detectFormat, printDocs } from "../output.ts";
import type { ParsedArgs } from "../args.ts";
import { stringFlag } from "../args.ts";

export function accountsCmd(args: ParsedArgs): void {
  const sub = args.positional[0] ?? "list";
  const cfg = loadConfig();

  switch (sub) {
    case "list": {
      const rows = Object.entries(cfg.profiles).map(([name, p]) => ({
        account: name,
        provider: p.provider,
        channel: p.channel_title ?? "",
        default: cfg.default === name ? "*" : "",
      }));
      printDocs(rows, detectFormat(stringFlag(args.flags, "output")));
      return;
    }
    case "use": {
      const name = args.positional[1];
      if (!name || !cfg.profiles[name]) {
        throw new Error(`Account '${name ?? ""}' not found. Run: postctl accounts list`);
      }
      cfg.default = name;
      saveConfig(cfg);
      console.log(`Default account → '${name}'`);
      return;
    }
    case "remove": {
      const name = args.positional[1];
      if (!name) throw new Error("Usage: postctl accounts remove <name>");
      const profile = cfg.profiles[name];
      if (profile) deleteToken(`${profile.provider}/${name}`);
      removeProfile(name);
      console.log(`Account '${name}' removed (token deleted).`);
      return;
    }
    default:
      throw new Error(`Unknown subcommand 'accounts ${sub}'. Use: list | use <name> | remove <name>`);
  }
}
