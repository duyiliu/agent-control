#!/bin/sh
set -e
# Session-open staging: the scheduler tars runner auth dirs into /ac before
# the run; move them into home so pi/codex find their file-based config.
if [ -d /ac/pi-auth ]; then
  mkdir -p "$HOME/.pi/agent"
  cp -r /ac/pi-auth/. "$HOME/.pi/agent/"
fi
if [ -d /ac/codex-auth ]; then
  mkdir -p "$HOME/.codex"
  cp -r /ac/codex-auth/. "$HOME/.codex/"
fi
exec "$@"
