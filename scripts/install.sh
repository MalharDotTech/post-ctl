#!/bin/sh
# postctl installer — downloads a prebuilt standalone binary from the latest
# GitHub Release, verifies its SHA-256, and installs it to ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/MalharDotTech/post-ctl/main/scripts/install.sh | sh
#
# Overrides (env): POSTCTL_VERSION=v0.3.0   pin a specific release tag
# No sudo, no self-update, no version flags beyond POSTCTL_VERSION. Boring.
set -eu

REPO="MalharDotTech/post-ctl"
BIN="postctl"

err() { printf 'postctl-install: %s\n' "$1" >&2; exit 1; }

# ── platform detection ──────────────────────────────────────────────────────
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) err "unsupported OS '$os'. Supported: macOS, Linux. Windows: use the npm package (npm i -g postctl)." ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) err "unsupported architecture '$arch'. Supported: arm64, x64." ;;
esac
asset="postctl-${os}-${arch}"

# ── release location ────────────────────────────────────────────────────────
if [ "${POSTCTL_VERSION:-}" != "" ]; then
  base="https://github.com/${REPO}/releases/download/${POSTCTL_VERSION}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi

# ── download tools ──────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  err "need curl or wget to download."
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t postctl)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s …\n' "$asset"
fetch "${base}/${asset}" "${tmp}/${BIN}" || err "download failed for ${asset} (no such release asset?)."
fetch "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" || err "could not fetch SHA256SUMS."

# ── checksum verification (mandatory) ───────────────────────────────────────
expected=$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | awk '{print $1}')
[ -n "$expected" ] || err "no checksum for ${asset} in SHA256SUMS."
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${tmp}/${BIN}" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "${tmp}/${BIN}" | awk '{print $1}')
else
  err "need sha256sum or shasum to verify the download."
fi
[ "$expected" = "$actual" ] || err "checksum mismatch — aborting (expected $expected, got $actual)."
printf 'Checksum OK.\n'

# ── install location (never sudo) ───────────────────────────────────────────
dir="${HOME}/.local/bin"
if [ ! -d "$dir" ]; then mkdir -p "$dir" 2>/dev/null || dir=""; fi
if [ -z "$dir" ] || [ ! -w "$dir" ]; then
  if [ -w /usr/local/bin ]; then
    dir="/usr/local/bin"
  else
    err "no writable install dir (~/.local/bin or /usr/local/bin). Create ~/.local/bin and re-run."
  fi
fi

chmod +x "${tmp}/${BIN}"
mv "${tmp}/${BIN}" "${dir}/${BIN}"
printf 'Installed postctl → %s/%s\n' "$dir" "$BIN"

# ── PATH hint ───────────────────────────────────────────────────────────────
case ":${PATH}:" in
  *":${dir}:"*) ;;
  *) printf '\nAdd it to PATH:\n  export PATH="%s:$PATH"\n' "$dir" ;;
esac
printf '\nNext: postctl setup youtube\n'
