#!/usr/bin/env bash
# Install the Baldborg overlay integration into this Omarchy/Hyprland system.
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

# Remove the module from the previous name, if any.
if grep -q 'require("hypr.delamain")' "$HYPR/hyprland.lua" 2>/dev/null; then
  sed -i '/require("hypr.delamain")/d' "$HYPR/hyprland.lua"
  echo "removed legacy hypr.delamain requirement"
fi
rm -f "$HYPR/delamain.lua"

# The Lua module needs absolute paths; substitute the repo location.
sed "s|__REPO__|$REPO|g" "$REPO/config/hypr/baldborg.lua" > "$HYPR/baldborg.lua"

if ! grep -q 'require("hypr.baldborg")' "$HYPR/hyprland.lua"; then
  cp "$HYPR/hyprland.lua" "$HYPR/hyprland.lua.bak.$(date +%s)"
  printf '\nrequire("hypr.baldborg")\n' >> "$HYPR/hyprland.lua"
  echo "added require to hyprland.lua"
else
  echo "hyprland.lua already requires hypr.baldborg"
fi

# Theme hook: adopt the accent colour when Omarchy changes theme.
HOOK_DIR="$HOME/.config/omarchy/hooks/theme-set.d"
if [[ -d "$HOME/.config/omarchy" ]]; then
  mkdir -p "$HOOK_DIR"
  sed "s|__REPO__|$REPO|g" "$REPO/config/omarchy/theme-set.sh" > "$HOOK_DIR/baldborg-theme.sh"
  chmod +x "$HOOK_DIR/baldborg-theme.sh"
  echo "installed theme-set hook"
fi

hyprctl reload >/dev/null
echo "config errors:"
hyprctl configerrors
echo
echo "Done. Bindings: Super+Shift+D toggle, Super+Shift+M mute, Super+Shift+H hide."
