#!/bin/sh
# The real Codex CLI, with the model pinned to one this account is permitted to use.
exec codex -c 'model="gpt-5.5"' "$@"
