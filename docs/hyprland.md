# Hyprland integration

Omarchy configures Hyprland in **Lua** (`~/.config/hypr/*.lua`), so the overlay
is registered with `hl.window_rule` instead of the old `windowrulev2` syntax.

## Install

```sh
./scripts/install-hyprland.sh
```

The script copies `config/hypr/delamain.lua` into `~/.config/hypr/`, appends
`require("hypr.delamain")` to `hyprland.lua` (with a timestamped backup), and
reloads Hyprland. It is idempotent.

Bindings created by the file:

| Binding | Action |
| --- | --- |
| `Super+Alt+D` | Toggle interactive mode |
| `Super+Alt+M` | Mute / unmute voice |
| `Super+Alt+H` | Hide the overlay |

`Super+Shift+D` and `Super+Shift+M` were already taken by Docker and Music, so
the companion uses `Alt` instead.

## What the rules do

```lua
o.window("^delamain-desktop$", {
  float = true,
  pin = true,
  no_initial_focus = true,
  no_blur = true,
  no_shadow = true,
  no_anim = true,
  border_size = 0,
  size = { 700, 700 },
  move = { "monitor_w-window_w-48", "monitor_h-window_h-48" },
})
```

| Rule | Reason |
| --- | --- |
| `float` | The window must not be tiled |
| `pin` | Visible on every workspace |
| `no_initial_focus` | Never steals focus at launch, but can still be focused when you open the chat bar |
| `no_blur` | Blur behind a transparent overlay costs GPU for nothing |
| `no_shadow`, `border_size = 0`, `no_anim` | The hologram provides its own framing; compositor effects only add artifacts |

## Keybindings and why they do not use Electron

Wayland forbids application-level global hotkeys, so Electron's
`globalShortcut` only works under X11/XWayland. The compositor owns the keys
instead and calls `bin/delamain`, which speaks to the app over a UNIX socket at
`~/.config/delamain/control.sock`.

Available commands: `toggle`, `open`, `close`, `mute`, `show`, `hide`,
`quit`, `capture` (writes `/tmp/opencode/delamain-capture.png`, useful for
debugging the renderer).

## Verify

```sh
hyprctl clients -j | jq -r '.[] | select(.class | test("delamain")) | "\(.class) at=\(.at) size=\(.size) pinned=\(.pinned)"'
```

Expected:

```
delamain-desktop at=[1172, 332] size=[700, 700] pinned=true
```

If the class differs, change `WM_CLASS` in `apps/desktop/electron/main.js`.
If nothing matches, the window is running under XWayland; force native Wayland
with `ELECTRON_OZONE_PLATFORM_HINT=wayland npm start`.

## Click-through and focus

In passive mode the main process calls
`win.setIgnoreMouseEvents(true, { forward: true })`, which makes the surface
transparent to input without hiding it. Under Wayland, `forward` delivers no
motion events, so hover effects are disabled in passive mode by design.

Focus is managed through `hyprctl`: before the window appears the app records
the focused window, and every return to passive mode dispatches
`focuswindow address:<saved>`. This is the only reliable way to give focus back
on a compositor that does not honour `win.blur()`.

## Positioning

Wayland clients cannot place their own windows, so the `move` rule in
`config/hypr/delamain.lua` is the single source of truth for the initial
position (monitor-local coordinates, 48 px margin from the bottom-right
corner). Dragging works in interactive mode through the grip bar above the
input (`-webkit-app-region: drag`).

Positions are not persisted across restarts yet: Hyprland would need a
per-window memory or an `exec-once` dispatcher, and the extra moving parts
caused more bugs than value in phase 1.
