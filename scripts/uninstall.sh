#!/usr/bin/env bash
# Removes the Hyprland integration and, with --purge, the local data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HYPR="$HOME/.config/hypr"

info() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

info "Stopping the overlay"
"$ROOT/bin/baldborg" quit 2>/dev/null || true

info "Removing the Hyprland module"
if [[ -f "$HYPR/hyprland.lua" ]] && grep -q 'require("hypr.baldborg")' "$HYPR/hyprland.lua"; then
  cp "$HYPR/hyprland.lua" "$HYPR/hyprland.lua.bak.$(date +%s)"
  sed -i '/require("hypr.baldborg")/d' "$HYPR/hyprland.lua"
fi
rm -f "$HYPR/baldborg.lua"
rm -f "$HOME/.config/omarchy/hooks/theme-set.d/baldborg-theme.sh"
rm -f "$HOME/.config/omarchy/hooks/post-update.d/baldborg-update.sh"
hyprctl reload >/dev/null 2>&1 || true

if [[ "${1:-}" == "--purge" ]]; then
  info "Purging local data"
  rm -rf "$HOME/.config/baldborg" "${XDG_STATE_HOME:-$HOME/.local/state}/baldborg"
fi

info "Done"
echo "Models (Kokoro, Ollama) and the repository were left untouched."
