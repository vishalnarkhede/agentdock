#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEWORKS_DIR="$ROOT/Frameworks"
FRAMEWORK="$FRAMEWORKS_DIR/GhosttyKit.xcframework"
GHOSTTY_SHA="5045df3f2072f0725394c87cebcc854b634e2131"
BUILD_FLAVOR="crashsubdir-cmux-crash-sentry-off-v1"
EXPECTED_SHA256="78f0b438bcc0957a77b6d71ba9795cb55b1ae158bda9d52aac4215a688bebb94"
ARCHIVE="$FRAMEWORKS_DIR/GhosttyKit.xcframework.tar.gz"
REPOSITORY="manaflow-ai/ghostty"
TAG="xcframework-${GHOSTTY_SHA}-${BUILD_FLAVOR}"

if [[ -d "$FRAMEWORK" ]]; then
  echo "GhosttyKit is already installed at $FRAMEWORK"
  exit 0
fi

mkdir -p "$FRAMEWORKS_DIR"
gh release download "$TAG" \
  --repo "$REPOSITORY" \
  --pattern "GhosttyKit.xcframework.tar.gz" \
  --dir "$FRAMEWORKS_DIR" \
  --clobber

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  rm -f "$ARCHIVE"
  echo "GhosttyKit checksum mismatch: expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xzf "$ARCHIVE" -C "$FRAMEWORKS_DIR"
rm -f "$ARCHIVE"
echo "Installed verified GhosttyKit at $FRAMEWORK"
