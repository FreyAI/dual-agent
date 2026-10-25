#!/usr/bin/env bash
# Installs (or removes) Dual Agent in VS Code on macOS and Linux.
#
#   ./install.sh                  install into every VS Code-family editor found
#   ./install.sh code-insiders    install into the named editor CLIs only
#   ./install.sh --uninstall      remove it again
#
# Picks the VSIX that matches this machine (Apple silicon or Intel Mac,
# x64 or arm64 Linux) from the folder this script is in, or from ../dist.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
UNINSTALL=0
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) WANTED+=("$arg") ;;
  esac
done

# The extension id is <publisher>.<name> from package.json, which sits next to this
# script in dist/ (copied there by scripts/package.mjs) or one folder up in the repo.
PKG=""
for p in "$HERE/package.json" "$HERE/../package.json"; do
  if [ -f "$p" ]; then PKG=$p; break; fi
done
if [ -z "$PKG" ]; then
  echo "package.json not found next to this script or in its parent folder." >&2
  exit 1
fi
pub=$(sed -n 's/^  "publisher": *"\([^"]*\)".*/\1/p' "$PKG" | head -n 1)
pkg_name=$(sed -n 's/^  "name": *"\([^"]*\)".*/\1/p' "$PKG" | head -n 1)
if [ -z "$pub" ] || [ -z "$pkg_name" ]; then
  echo "No top-level \"publisher\" and \"name\" in $PKG." >&2
  exit 1
fi
EXT_ID="$pub.$pkg_name"

# --- Which build fits this machine --------------------------------------------
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "This script supports macOS and Linux. On Windows run install\\install.ps1 (or: make install)." >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    echo "Unsupported CPU: $(uname -m)" >&2
    exit 1
    ;;
esac
# Rosetta reports x86_64 on Apple silicon; the native build is the right one.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
target="$os-$arch"

if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  echo "Note: this looks like a musl system (e.g. Alpine). The bundled agent is built for glibc and may not start." >&2
fi

# --- Which editors to install into ---------------------------------------------
find_clis() {
  local names=("$@")
  if [ ${#names[@]} -eq 0 ]; then
    names=(code code-insiders codium cursor windsurf)
  fi
  local found=()
  for name in "${names[@]}"; do
    if command -v "$name" >/dev/null 2>&1; then
      found+=("$(command -v "$name")")
    fi
  done
  # On macOS the `code` command is often not on PATH; use the app bundle directly.
  if [ "$os" = darwin ]; then
    for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app" \
      "/Applications/Visual Studio Code - Insiders.app" "/Applications/VSCodium.app" "/Applications/Cursor.app"; do
      for bin in "$app/Contents/Resources/app/bin/code" "$app/Contents/Resources/app/bin/code-insiders" \
        "$app/Contents/Resources/app/bin/codium" "$app/Contents/Resources/app/bin/cursor"; do
        [ -x "$bin" ] || continue
        if [ ${#WANTED[@]} -gt 0 ] && [[ ! " ${WANTED[*]} " == *" $(basename "$bin") "* ]]; then
          continue
        fi
        found+=("$bin")
        break
      done
    done
  fi
  # Several entries can be the same editor (PATH symlink and app bundle).
  local seen=() cli real
  for cli in "${found[@]+"${found[@]}"}"; do
    real=$(readlink -f "$cli" 2>/dev/null || echo "$cli")
    [[ " ${seen[*]-} " == *" $real "* ]] && continue
    seen+=("$real")
    echo "$cli"
  done
}

CLIS=()
while IFS= read -r line; do
  [ -n "$line" ] && CLIS+=("$line")
done < <(find_clis "${WANTED[@]+"${WANTED[@]}"}")

if [ ${#CLIS[@]} -eq 0 ]; then
  echo "No VS Code command line found." >&2
  echo "In VS Code, run \"Shell Command: Install 'code' command in PATH\" from the Command Palette, then run this again." >&2
  exit 1
fi

if [ $UNINSTALL -eq 1 ]; then
  for cli in "${CLIS[@]}"; do
    echo "Removing from $(basename "$cli")…"
    "$cli" --uninstall-extension "$EXT_ID" || true
  done
  exit 0
fi

# --- Install -------------------------------------------------------------------
vsix=""
for dir in "$HERE" "$HERE/../dist"; do
  candidate=$(ls -t "$dir"/dual-agent-*-"$target".vsix 2>/dev/null | head -1 || true)
  if [ -n "$candidate" ]; then
    vsix=$candidate
    break
  fi
done
if [ -z "$vsix" ]; then
  echo "No Dual Agent build for $target next to this script." >&2
  echo "Build it with: make package   (or: node scripts/package.mjs)" >&2
  exit 1
fi

echo "Installing $(basename "$vsix") for $target"
for cli in "${CLIS[@]}"; do
  echo "  → $(basename "$cli")"
  # Remove the old version first: a rebuild keeps the version number, and the
  # editor could otherwise keep the copy it already has.
  if "$cli" --list-extensions 2>/dev/null | grep -qix "$EXT_ID"; then
    echo "    removing the installed version"
    "$cli" --uninstall-extension "$EXT_ID" >/dev/null || true
  fi
  "$cli" --install-extension "$vsix" --force
done
echo
echo "Done. Reload VS Code (Developer: Reload Window), then open Dual Agent from the activity bar."
