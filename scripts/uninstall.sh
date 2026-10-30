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
rm -f "$HOME/.config/omarchy/hooks/battery-low.d/baldborg-battery.sh"
hyprctl reload >/dev/null 2>&1 || true

rm -f "$HOME/.local/share/applications/baldborg.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/baldborg.png"

PLUGIN_ID="nickmdrummer.baldborg"
rm -rf "$HOME/.config/omarchy/plugins/$PLUGIN_ID"
SHELL_JSON="$HOME/.config/omarchy/shell.json"
if [[ -f "$SHELL_JSON" ]] && grep -q "\"$PLUGIN_ID\"" "$SHELL_JSON"; then
  cp "$SHELL_JSON" "$SHELL_JSON.bak.$(date +%s)"
  python3 - "$SHELL_JSON" "$PLUGIN_ID" <<'PY'
import json
import sys

path, plugin = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)

layout = data.get("bar", {}).get("layout", {})
for section in ("left", "center", "right"):
    entries = [e for e in layout.get(section, []) if not (isinstance(e, dict) and e.get("id") == plugin)]
    layout[section] = entries

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
fi
omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true

if [[ "${1:-}" == "--purge" ]]; then
  info "Purging local data"
  rm -rf "$HOME/.config/baldborg" "${XDG_STATE_HOME:-$HOME/.local/state}/baldborg"
fi

info "Done"
echo "Models (Kokoro, Ollama) and the repository were left untouched."
