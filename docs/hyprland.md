# Hyprland integration

Omarchy configures Hyprland in **Lua** (`~/.config/hypr/*.lua`), so the overlay
is registered with `hl.window_rule` instead of the old `windowrulev2` syntax.

## Install

```sh
./scripts/install-hyprland.sh
```

The script copies `config/hypr/baldborg.lua` into `~/.config/hypr/`, appends
`require("hypr.baldborg")` to `hyprland.lua` (with a timestamped backup), and
reloads Hyprland. It is idempotent.

Bindings created by the file:

| Binding | Action |
| --- | --- |
| `Super+Shift+D` | Toggle interactive mode |
| `Super+Shift+M` | Mute / unmute voice |
| `Super+Shift+R` | Replay the last reply |
| `Super+Shift+H` | Hide the overlay |

`Super+Shift+D` and `Super+Shift+M` were previously bound to Docker and
Music; the module calls `hl.unbind` before `o.bind` so the old actions are
gone. `Super+Shift+H` was free.

## What the rules do

```lua
o.window("^baldborg-desktop$", {
  float = true,
  pin = true,
  no_initial_focus = true,
  no_blur = true,
  no_shadow = true,
  no_anim = true,
  border_size = 0,
})

o.window("^baldborg-desktop$", {
  size = { 200, 330 },
  move = { "(monitor_w-200-24)", "(monitor_h-330-24)" },
})
```

| Rule | Reason |
| --- | --- |
| `float` | The window must not be tiled |
| `pin` | Visible on every workspace |
| `no_initial_focus` | Never steals focus at launch, but can still be focused when you open the chat bar |
| `no_blur` | Blur behind a transparent overlay costs GPU for nothing |
| `no_shadow`, `border_size = 0`, `no_anim` | The hologram provides its own framing; compositor effects only add artifacts |

Placement lives in a second rule on purpose: `move` is only honoured for
floating windows, and keeping it separate guarantees it is evaluated after
`float` is in effect. Expressions must be parenthesised, otherwise they are
parsed as literal strings and silently ignored.

`size` is only the initial geometry (passive mode). The app resizes its own
surface: 200x330 for the head and the proactive line, 380x460 when the
chat opens.

## Keybindings and why they do not use Electron

Wayland forbids application-level global hotkeys, so Electron's
`globalShortcut` only works under X11/XWayland. The compositor owns the keys
instead and calls `bin/baldborg`, which speaks to the app over a UNIX socket at
`~/.config/baldborg/control.sock`.

Available commands: `toggle`, `open`, `close`, `mute`, `forget`, `speak`,
`beat`, `theme`, `announce "<text>"`, `glitch`, `show`, `hide`, `quit`,
`capture` (writes `/tmp/opencode/baldborg-capture.png`, useful for
debugging the renderer).

## Pointer warping

This was the cause of the "cursor jumps back to the middle of the screen"
bug: every time Hyprland changed focus it warped the pointer to the centre of
the newly focused window. The overlay takes focus on hover (follow-mouse), the
app hands focus back to the previous window, and the warp landed in the middle
of that window.

Hyprland exposes this as `cursor:no_warps`, which has no CLI keyword form in
0.56 (the config uses non-legacy parsers), so the app disables it at startup
and restores the previous value on quit:

```sh
hyprctl eval 'hl.config({ cursor = { no_warps = true } })'
```

While the companion runs, focus changes do not move the pointer. The toggle is
not optional: the overlay hands focus back and forth on every hover, so with
warping enabled the cursor would jump to the centre of the other window. If you
ever need warping back, remove the `enableNoWarps()` call in
`apps/desktop/electron/main.js`.

## Resizing

`hl.dsp.window.move` and `hl.dsp.window.resize` act on the **active** window,
not on a selector, so the app focuses the overlay for a few milliseconds,
resizes/moves it, and gives focus back when it is in passive mode. With
`no_warps` enabled this dance is invisible.

## Verify

```sh
hyprctl clients -j | jq -r '.[] | select(.class | test("baldborg")) | "\(.class) at=\(.at) size=\(.size) pinned=\(.pinned)"'
```

Expected:

```
baldborg-desktop at=[1606, 726] size=[200, 330] pinned=true
```

with the chat open:

```
baldborg-desktop at=[1516, 596] size=[380, 460] pinned=true
```

The head keeps its centre and top edge between both states; only the surface
grows to make room for the console.

If the class differs, change `WM_CLASS` in `apps/desktop/electron/main.js`.
If nothing matches, the window is running under XWayland; force native Wayland
with `ELECTRON_OZONE_PLATFORM_HINT=wayland npm start`.

## Click-through and focus

In passive mode the main process calls
`win.setIgnoreMouseEvents(true, { forward: true })`, which makes the surface
transparent to input without hiding it. Under Wayland, `forward` delivers no
motion events, so hover effects are disabled in passive mode by design.

Focus needs two things, because `win.blur()` does nothing under Hyprland and
focus-follow-mouse grabs the overlay when the pointer crosses it:

1. `no_focus = true` on the window (`hl.dsp.window.set_prop`) so the compositor
   never focuses it on hover.
2. An explicit handoff when the mode changes: Hyprland does not drop focus from
   a window that becomes non-focusable, so the app focuses the most recently
   used window **of the current workspace**
   (`focusHistoryID` order, never another workspace).

That second rule is what fixed the workspace ping-pong: restoring a window that
lived on workspace 1 switched the composer to workspace 1, the pinned overlay
was still under the pointer, it took focus again, and the cycle repeated.

Pinned windows also keep a "home" workspace; focusing one from another
workspace makes Hyprland jump there. When the chat opens on a different
workspace, the app first adopts it with
`hl.dsp.window.move({ workspace = "<id>", window = "class:baldborg-desktop" })`.

## Positioning

Wayland clients cannot place their own windows, so the `move` rule in
`config/hypr/baldborg.lua` is the single source of truth for the initial
position (monitor-local coordinates, 24 px margin from the bottom-right
corner). Dragging works in interactive mode through the grip bar above the
input (`-webkit-app-region: drag`).

Positions are not persisted across restarts yet: Hyprland would need a
per-window memory or an `exec-once` dispatcher, and the extra moving parts
caused more bugs than value in phase 1.

## Fractional scale

Chromium asked for a 1.1875 device scale factor on this setup, rendering a
452x357 buffer for a 380x300 surface. Hyprland then showed only the top-left
corner, which cut the bottom of the chat bar. The main process now forces
`--force-device-scale-factor=1`, so one CSS pixel is one screen pixel. If you
change the window size, keep that in mind: the values in CSS are the real
pixels.
