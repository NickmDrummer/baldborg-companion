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

# Omarchy hooks: theme accent and a line after updates.
if [[ -d "$HOME/.config/omarchy" ]]; then
  install_hook() {
    local event="$1" source="$2" name="$3"
    local dir="$HOME/.config/omarchy/hooks/${event}.d"
    mkdir -p "$dir"
    sed "s|__REPO__|$REPO|g" "$source" > "$dir/$name"
    chmod +x "$dir/$name"
    echo "installed ${event} hook"
  }
  install_hook theme-set "$REPO/config/omarchy/theme-set.sh" baldborg-theme.sh
  install_hook post-update "$REPO/config/omarchy/post-update.sh" baldborg-update.sh
  install_hook battery-low "$REPO/config/omarchy/battery-low.sh" baldborg-battery.sh
fi

# Launcher entry and icon, so the app can be opened from the menu.
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"
cp "$REPO/assets/icon/baldborg.png" "$ICON_DIR/baldborg.png"
sed -e "s|__REPO__|$REPO|g" -e "s|__ICON__|baldborg|g" \
  "$REPO/config/baldborg.desktop" > "$APPS_DIR/baldborg.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
echo "installed launcher entry"

# User tools directory with a documented example.
TOOLS_DIR="$HOME/.config/baldborg/tools"
if [[ -d "$HOME/.config/baldborg" || -d "$HOME/.config" ]]; then
  mkdir -p "$TOOLS_DIR"
  cp "$REPO/config/tools/README.md" "$TOOLS_DIR/README.md"
  if [[ ! -f "$TOOLS_DIR/example-disk.mjs" ]]; then
    cp "$REPO/config/tools/example-disk.mjs" "$TOOLS_DIR/example-disk.mjs"
    echo "installed example user tool"
  fi
fi

# Omarchy bar widget.
PLUGIN_ID="nickmdrummer.baldborg"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
SHELL_JSON="$HOME/.config/omarchy/shell.json"
if [[ -d "$HOME/.config/omarchy" ]]; then
  mkdir -p "$PLUGIN_DIR"
  cp "$REPO/config/omarchy/plugin/manifest.json" "$PLUGIN_DIR/"
  sed "s|__REPO__|$REPO|g" "$REPO/config/omarchy/plugin/BarWidget.qml" > "$PLUGIN_DIR/BarWidget.qml"
  omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true

  if [[ -f "$SHELL_JSON" ]] && ! grep -q "\"$PLUGIN_ID\"" "$SHELL_JSON"; then
    cp "$SHELL_JSON" "$SHELL_JSON.bak.$(date +%s)"
    python3 - "$SHELL_JSON" "$PLUGIN_ID" <<'PY'
import json
import sys

path, plugin = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

layout = data.setdefault("bar", {}).setdefault("layout", {})
left = layout.setdefault("left", [])
if not any(isinstance(entry, dict) and entry.get("id") == plugin for entry in left):
    left.append({"id": plugin})

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
    echo "added $PLUGIN_ID to the bar (left)"
  fi
fi

hyprctl reload >/dev/null
echo "config errors:"
hyprctl configerrors
echo
echo "Done. Bindings: Super+Shift+D toggle, Super+Shift+M mute, Super+Shift+H hide."
