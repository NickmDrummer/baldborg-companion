-- Baldborg companion overlay (personal project, safe to remove)
-- Requires http://127.0.0.1:11434 (ollama) only when chatting.

o.window("^baldborg-desktop$", {
  float = true,
  pin = true,
  no_initial_focus = true,
  no_blur = true,
  no_shadow = true,
  no_anim = true,
  border_size = 0,
})

-- Placement is a separate rule so it is evaluated after `float` is in effect.
-- Tight 208x222 idle frame; the app grows sideways to 568x222 for chat.
o.window("^baldborg-desktop$", {
  move = { "(monitor_w-208-8)", "(monitor_h-222-8)" },
})

-- These keys belong to Baldborg now: SUPER+SHIFT+D was Docker and
-- SUPER+SHIFT+M was Music. Unbind first or Hyprland keeps the old action.
hl.unbind("SUPER + SHIFT + D")
hl.unbind("SUPER + SHIFT + H")
hl.unbind("SUPER + SHIFT + M")
hl.unbind("SUPER + SHIFT + V")

local baldborg = "__REPO__/bin/baldborg"

o.bind("SUPER + SHIFT + D", "Baldborg: modo interactivo", baldborg .. " toggle")
o.bind("SUPER + SHIFT + M", "Baldborg: voz on/off", baldborg .. " voice-toggle")

-- Push-to-talk: record while V is held, transcribe on release.
o.bind("SUPER + SHIFT + V", "Baldborg: hablar (mantener)", baldborg .. " listen start")
o.bind("SUPER + SHIFT + V", "Baldborg: hablar (soltar)", baldborg .. " listen stop", { release = true })

-- Start the overlay with the session (single-instance safe).
o.launch_on_start("__REPO__/bin/baldborg-start")
o.bind("SUPER + SHIFT + H", "Baldborg: ocultar", baldborg .. " hide")

-- SUPER + SHIFT + LMB on the idle status pill starts a clamped drag.
-- Plain SUPER + LMB stays the normal Omarchy window drag.
local function over_pill()
  local w = hl.get_window("class:baldborg-desktop")
  if w == nil then return false end
  local c = hl.get_cursor_pos()
  local pill_w = math.min(180, w.size.x)
  local left = w.at.x + (w.size.x - pill_w) / 2
  local top = w.at.y + w.size.y - 20
  return c.x >= left and c.x <= left + pill_w and c.y >= top and c.y <= w.at.y + w.size.y
end

-- Super+LMB stays the normal Omarchy window drag. The idle pill uses
-- Super+Shift+LMB so the two actions do not fight.
hl.bind("SUPER + SHIFT + mouse:272", function()
  if over_pill() then
    hl.dispatch(hl.dsp.exec_cmd(baldborg .. " drag-start"))
  end
end, { mouse = true })
hl.bind("SUPER + SHIFT + mouse:272", hl.dsp.exec_cmd(baldborg .. " drag-end"), { mouse = true, release = true })
hl.bind("mouse:272", hl.dsp.exec_cmd(baldborg .. " drag-end"), { mouse = true, release = true, non_consuming = true })
