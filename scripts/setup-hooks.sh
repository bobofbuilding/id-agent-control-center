#!/bin/sh
# Enable the repo's git hooks (one-time, per clone). Points git at
# scripts/hooks so the commit-msg version stamp runs on every commit.
set -e
root="$(git rev-parse --show-toplevel)"
chmod +x "$root/scripts/hooks/"* 2>/dev/null || true
git config core.hooksPath scripts/hooks
echo "✓ core.hooksPath = scripts/hooks (commit-msg version stamp enabled)"
