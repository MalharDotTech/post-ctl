#!/usr/bin/env bun
// Compile standalone binaries (embedded Bun runtime) for every release target.
// End users need no Bun/Node. Output: dist/postctl-<os>-<arch>[.exe].
//
//   bun run scripts/build.ts            # all targets
//   bun run scripts/build.ts darwin-arm64   # one target
//
// Cross-compilation is native to `bun build --compile --target=…` — no
// toolchain per platform. Zero runtime deps (CLAUDE.md hard rule) keeps this
// a pure Bun step.

import { mkdirSync, rmSync } from "fs";
import { join } from "path";

interface Target {
  id: string;           // dist suffix, e.g. "darwin-arm64"
  bunTarget: string;    // bun --target value
  exe?: boolean;        // append .exe (Windows)
}

const TARGETS: Target[] = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { id: "linux-x64", bunTarget: "bun-linux-x64" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { id: "windows-x64", bunTarget: "bun-windows-x64", exe: true },
];

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src", "cli.ts");

async function buildTarget(t: Target): Promise<void> {
  const outfile = join(DIST, `postctl-${t.id}${t.exe ? ".exe" : ""}`);
  const proc = Bun.spawn(
    [
      "bun", "build", "--compile", "--minify",
      `--target=${t.bunTarget}`,
      ENTRY, "--outfile", outfile,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`build failed for ${t.id} (exit ${code})`);
  console.log(`  ✓ ${outfile}`);
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const targets = only ? TARGETS.filter((t) => t.id === only) : TARGETS;
  if (only && targets.length === 0) {
    console.error(`Unknown target '${only}'. Known: ${TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  console.log(`Building ${targets.length} target(s) → dist/`);
  for (const t of targets) await buildTarget(t);
  console.log("Done.");
}

await main();
