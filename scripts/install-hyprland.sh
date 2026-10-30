#!/usr/bin/env bash
# Install the Delamain overlay integration into this Omarchy/Hyprland system.
#
# Idempotent: copies the window rules and keybindings, then makes sure the
# main Hyprland config requires the file.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HYPR="$HOME/.config/hypr"

if [[ ! -f "$HYPR/hyprland.lua" ]]; then
  echo "error: $HYPR/hyprland.lua not found (is this an Omarchy/Hyprland system with Lua config?)" >&2
  exit 1
fi

# The Lua module needs absolute paths; substitute the repo location.
sed "s|__REPO__|$REPO|g" "$REPO/config/hypr/delamain.lua" > "$HYPR/delamain.lua"

if ! grep -q 'require("hypr.delamain")' "$HYPR/hyprland.lua"; then
  cp "$HYPR/hyprland.lua" "$HYPR/hyprland.lua.bak.$(date +%s)"
  printf '\nrequire("hypr.delamain")\n' >> "$HYPR/hyprland.lua"
  echo "added require to hyprland.lua"
else
  echo "hyprland.lua already requires hypr.delamain"
fi

hyprctl reload >/dev/null
echo "config errors:"
hyprctl configerrors
echo
echo "Done. Bindings: Super+Shift+D toggle, Super+Shift+M mute, Super+Shift+H hide."
