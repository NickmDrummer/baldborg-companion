#!/usr/bin/env bash
# One-shot installer for the companion overlay.
# Arch/Omarchy oriented: it expects node, uv, ollama and hyprctl on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

info() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*"; }
die() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

info "Checking dependencies"
for cmd in node npm uv ollama hyprctl; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing dependency: $cmd"
done

info "Installing Node dependencies and building the renderer"
cd "$ROOT/apps/desktop"
npm ci
npm run build

info "Preparing the voice sidecar (Kokoro)"
cd "$ROOT/services/voice"
uv sync
./download_assets.sh

info "Pulling local models (first run: ~4.5 GB)"
if ! pgrep -f "ollama serve" >/dev/null 2>&1; then
  warn "ollama does not look like it is running; start it before the first chat"
fi
ollama pull qwen3:4b-instruct-2507-q4_K_M || warn "could not pull qwen3 (is ollama running?)"
ollama pull llama3.2:3b || warn "could not pull llama3.2"

info "Installing the Hyprland integration"
"$ROOT/scripts/install-hyprland.sh"

info "Done"
LOG_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/delamain/app.log"
cat <<EOF

Start it now:      $ROOT/bin/delamain-start
Or log out and back in: it is registered with o.launch_on_start.

Bindings: Super+Shift+D toggle · M mute · R replay · H hide
Logs:     $LOG_FILE
EOF
