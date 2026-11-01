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
hl.unbind("SUPER + SHIFT + R")
hl.unbind("SUPER + SHIFT + V")

local baldborg = "__REPO__/bin/baldborg"

o.bind("SUPER + SHIFT + D", "Baldborg: modo interactivo", baldborg .. " toggle")
o.bind("SUPER + SHIFT + M", "Baldborg: silenciar voz", baldborg .. " mute")
o.bind("SUPER + SHIFT + R", "Baldborg: repetir voz", baldborg .. " speak")

-- Push-to-talk: record while V is held, transcribe on release.
o.bind("SUPER + SHIFT + V", "Baldborg: hablar (mantener)", baldborg .. " listen start")
o.bind("SUPER + SHIFT + V", "Baldborg: hablar (soltar)", baldborg .. " listen stop", { release = true })

-- Start the overlay with the session (single-instance safe).
o.launch_on_start("__REPO__/bin/baldborg-start")
o.bind("SUPER + SHIFT + H", "Baldborg: ocultar", baldborg .. " hide")

-- SUPER + LMB on the idle status pill starts a clamped drag. Anywhere else
-- the normal Omarchy window-drag behaviour is preserved.
hl.unbind("SUPER + mouse:272")
hl.bind("SUPER + mouse:272", function()
  local overlay = hl.get_window("class:baldborg-desktop")
  if overlay ~= nil then
    hl.dispatch(hl.dsp.exec_cmd(baldborg .. " drag-start"))
  else
    hl.dispatch(hl.dsp.window.drag())
  end
end, { mouse = true })
hl.bind("SUPER + mouse:272", hl.dsp.exec_cmd(baldborg .. " drag-end"), { mouse = true, release = true })
hl.bind("mouse:272", hl.dsp.exec_cmd(baldborg .. " drag-end"), { mouse = true, release = true })
