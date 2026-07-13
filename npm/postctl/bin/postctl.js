#!/usr/bin/env node
// Node-compatible launcher (CJS — runs under whatever runtime npm used; must
// NOT use Bun APIs). Resolves the platform-specific binary from an optional
// dependency and re-execs it, forwarding argv/stdio and the exit code.
"use strict";

const { spawnSync } = require("child_process");

// npm platform packages are keyed on process.platform/process.arch.
const PKG_BY_KEY = {
  "darwin-arm64": "@post-ctl/darwin-arm64",
  "darwin-x64": "@post-ctl/darwin-x64",
  "linux-x64": "@post-ctl/linux-x64",
  "linux-arm64": "@post-ctl/linux-arm64",
  "win32-x64": "@post-ctl/win32-x64",
};

const key = `${process.platform}-${process.arch}`;
const pkg = PKG_BY_KEY[key];
const INSTALLER = "https://post-ctl.pages.dev/install.sh";

if (!pkg) {
  process.stderr.write(
    `postctl: no prebuilt binary for your platform (${key}).\n` +
      `Supported: ${Object.keys(PKG_BY_KEY).join(", ")}.\n` +
      `Try the standalone installer: curl -fsSL ${INSTALLER} | sh\n`,
  );
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
let binary;
try {
  // Platform packages ship the binary at bin/postctl[.exe] and declare no bin
  // field (avoids clashing with this launcher's bin symlink).
  binary = require.resolve(`${pkg}/bin/postctl${ext}`);
} catch {
  process.stderr.write(
    `postctl: platform package ${pkg} is not installed.\n` +
      `This usually means optionalDependencies were skipped. Reinstall with\n` +
      `  npm install -g postctl\n` +
      `or use the standalone installer: curl -fsSL ${INSTALLER} | sh\n`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`postctl: failed to launch binary: ${result.error.message}\n`);
  process.exit(1);
}
// Mirror signal-kills as the conventional 128+signal code; else pass status.
if (result.signal) process.exit(1);
process.exit(result.status === null ? 1 : result.status);
