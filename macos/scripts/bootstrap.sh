#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT/scripts/bootstrap-ghostty.sh"
xcodegen generate --spec "$ROOT/project.yml" --project "$ROOT"

echo "Generated $ROOT/AgentDock.xcodeproj"
