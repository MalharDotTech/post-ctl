#!/usr/bin/env bun
// Assemble the publishable npm tree into dist/npm/ from compiled binaries.
// Run AFTER scripts/build.ts. Produces:
//   dist/npm/postctl/                  main launcher package (version stamped)
//   dist/npm/@postctl/<plat>/          one platform package per binary
//
// Version is taken from root package.json (the single version source). CI
// publishes the platform packages first, then the main package, all at the
// same version as the git tag (release.yml enforces tag == version).

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "npm");

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

// dist binary id → npm platform key + os/cpu constraints.
interface Plat { distId: string; npmKey: string; os: string; cpu: string; exe?: boolean; }
const PLATS: Plat[] = [
  { distId: "darwin-arm64", npmKey: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { distId: "darwin-x64", npmKey: "darwin-x64", os: "darwin", cpu: "x64" },
  { distId: "linux-x64", npmKey: "linux-x64", os: "linux", cpu: "x64" },
  { distId: "linux-arm64", npmKey: "linux-arm64", os: "linux", cpu: "arm64" },
  { distId: "windows-x64", npmKey: "win32-x64", os: "win32", cpu: "x64", exe: true },
];

function platformPackage(p: Plat): void {
  const binName = `postctl-${p.distId}${p.exe ? ".exe" : ""}`;
  const src = join(DIST, binName);
  if (!existsSync(src)) throw new Error(`missing binary ${src} — run scripts/build.ts first`);

  const pkgDir = join(OUT, "@postctl", p.npmKey);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  cpSync(src, join(pkgDir, "bin", `postctl${p.exe ? ".exe" : ""}`));

  // No "bin" field: the binary is resolved by the main launcher via
  // require.resolve; declaring bin here would clash with the launcher symlink.
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: `@postctl/${p.npmKey}`,
        version: VERSION,
        description: `postctl prebuilt binary for ${p.os}-${p.cpu}`,
        os: [p.os],
        cpu: [p.cpu],
        files: ["bin/"],
        license: "MIT",
        repository: { type: "git", url: "https://github.com/MalharDotTech/postctl" },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  ✓ @postctl/${p.npmKey}`);
}

function mainPackage(): void {
  const outDir = join(OUT, "postctl");
  cpSync(join(ROOT, "npm", "postctl"), outDir, { recursive: true });

  const pkgPath = join(outDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version: string;
    optionalDependencies: Record<string, string>;
  };
  pkg.version = VERSION;
  for (const dep of Object.keys(pkg.optionalDependencies)) pkg.optionalDependencies[dep] = VERSION;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ✓ postctl (main launcher)`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
console.log(`Assembling npm tree v${VERSION} → dist/npm/`);
for (const p of PLATS) platformPackage(p);
mainPackage();
console.log("Done.");
