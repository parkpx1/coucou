#!/usr/bin/env bash
# Build, sign with a local Apple Development identity, and install to /Applications.
#
# This is NOT the release path. scripts/release.sh signs with a Developer ID
# Application certificate and notarizes with Apple, which is what lets the app run
# on someone else's Mac. This script exists for the common case of having only a
# free/personal Apple Development certificate: the app runs fine on the machine
# that built it, but Gatekeeper will still refuse it elsewhere because it is not
# notarized.
#
# Usage:
#   ./scripts/install-local.sh                      # auto-pick the first identity
#   ./scripts/install-local.sh "Apple Development: Jane Doe (ABC123)"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="/tmp/coucou-local"
APP_NAME="Coucou.app"
DEST="/Applications/$APP_NAME"

# ── 1. Signing identity ───────────────────────────────────────────────────────
IDENTITY="${1:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning \
    | grep "Apple Development" | head -1 \
    | sed 's/.*"\(Apple Development[^"]*\)".*/\1/')
fi
if [ -z "$IDENTITY" ]; then
  echo "error: no 'Apple Development' certificate found." >&2
  echo "       Add your Apple ID in Xcode → Settings → Accounts, then" >&2
  echo "       'Manage Certificates…' → + → Apple Development." >&2
  exit 1
fi
echo "==> Signing identity: $IDENTITY"

# ── 2. Generate project + build UNSIGNED ──────────────────────────────────────
# Built unsigned on purpose. project.yml pins the upstream author's
# DEVELOPMENT_TEAM, so letting xcodebuild sign fails with "No certificate for
# team … found" against any other account. Signing is done as a separate step
# below, which sidesteps the pinned team entirely.
command -v xcodegen >/dev/null || { echo "error: xcodegen not installed (brew install xcodegen)" >&2; exit 1; }

cd "$REPO_ROOT/NotchBuddy"
echo "==> xcodegen"
xcodegen > /dev/null

echo "==> Building Release (unsigned)"
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"
xcodebuild \
  -project NotchBuddy.xcodeproj \
  -scheme NotchBuddy \
  -configuration Release \
  build \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CONFIGURATION_BUILD_DIR="$BUILD_DIR" \
  > /tmp/coucou-build.log 2>&1 \
  || { echo "error: build failed — see /tmp/coucou-build.log" >&2; tail -20 /tmp/coucou-build.log >&2; exit 1; }

# ── 3. Sign ───────────────────────────────────────────────────────────────────
# --options runtime enables the hardened runtime; the entitlements file carries
# the Apple Events permission the window-attach and Mail features need.
echo "==> Signing"
codesign --force --deep \
  --sign "$IDENTITY" \
  --entitlements Resources/Coucou.entitlements \
  --options runtime \
  --timestamp \
  "$BUILD_DIR/$APP_NAME"

codesign --verify --deep --strict "$BUILD_DIR/$APP_NAME"
echo "==> Signature verified"

# ── 4. Install ────────────────────────────────────────────────────────────────
# Quit any running copy first: replacing the bundle under a live process leaves
# it running stale code and holding the hook socket.
if pgrep -f "$DEST" > /dev/null 2>&1 || pgrep -f "$BUILD_DIR/$APP_NAME" > /dev/null 2>&1; then
  echo "==> Quitting running instance"
  osascript -e 'tell application id "fr.louisraille.NotchBuddy" to quit' 2>/dev/null || true
  sleep 2
  pkill -f "$DEST" 2>/dev/null || true
  sleep 1
fi

echo "==> Installing to $DEST"
# macOS app-management protection can deny rm -rf on an existing bundle in
# /Applications, and a partial delete leaves an empty husk that also cannot be
# replaced. Clear it defensively: rmdir handles the husk case, and the final
# check fails with a usable instruction rather than a bare "Permission denied".
rm -rf "$DEST" 2>/dev/null || true
[ -d "$DEST" ] && rmdir "$DEST" 2>/dev/null || true
if [ -e "$DEST" ]; then
  echo "error: cannot replace $DEST (macOS app-management protection)." >&2
  echo "       Remove it in Finder, or grant Terminal access under" >&2
  echo "       System Settings → Privacy & Security → App Management, then re-run." >&2
  exit 1
fi
ditto "$BUILD_DIR/$APP_NAME" "$DEST"
rm -rf "$BUILD_DIR"

echo
echo "Installed: $DEST"
codesign -dv "$DEST" 2>&1 | grep -E 'Authority=Apple Development|TeamIdentifier' | sed 's/^/  /'
echo
echo "Note: 'spctl -a' will still reject this build — it is signed but not"
echo "notarized, which needs a paid Developer ID. If macOS blocks it, allow it"
echo "once under System Settings → Privacy & Security → Open Anyway."
echo
echo "Launch: open -a Coucou"
