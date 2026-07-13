import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Freshness check (frappe-ctl ADR-025 pattern): package.json is the single
// version source; cli.ts must not drift.
describe("version sync", () => {
  test("version.ts VERSION matches package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const { VERSION } = await import("./version.ts");
    expect(VERSION).toBe(pkg.version);
  });

  test("every provider in registry has a platform behavior doc", async () => {
    const { PROVIDERS } = await import("./provider.ts");
    for (const id of Object.keys(PROVIDERS)) {
      const doc = Bun.file(join(import.meta.dir, "..", "docs", "platforms", `${id}.md`));
      expect(await doc.exists()).toBe(true);
    }
  });
});
