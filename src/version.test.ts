import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Freshness check (frappe-ctl ADR-025 pattern): package.json is the single
// version source; cli.ts must not drift.
describe("version sync", () => {
  test("cli.ts VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    const match = /const VERSION = "([^"]+)"/.exec(cli);
    expect(match?.[1]).toBe(pkg.version);
  });

  test("every provider in registry has a platform behavior doc", async () => {
    const { PROVIDERS } = await import("./provider.ts");
    for (const id of Object.keys(PROVIDERS)) {
      const doc = Bun.file(join(import.meta.dir, "..", "docs", "platforms", `${id}.md`));
      expect(await doc.exists()).toBe(true);
    }
  });
});
