#!/bin/sh
# Command reviewer backed by MiniMax through OpenCode. Reads the review prompt on stdin.
cd "$(mktemp -d)" || exit 1
prompt=$(cat)
exec opencode run -m opencode-go/minimax-m3 "$prompt" 2>/dev/null
