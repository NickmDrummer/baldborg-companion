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
-- Size matches passive mode; the app grows the surface when the chat opens.
o.window("^baldborg-desktop$", {
  move = { "(monitor_w-200-24)", "(monitor_h-330-24)" },
})

-- These keys belong to Baldborg now: SUPER+SHIFT+D was Docker and
-- SUPER+SHIFT+M was Music. Unbind first or Hyprland keeps the old action.
hl.unbind("SUPER + SHIFT + D")
hl.unbind("SUPER + SHIFT + H")
hl.unbind("SUPER + SHIFT + M")
hl.unbind("SUPER + SHIFT + R")

local baldborg = "__REPO__/bin/baldborg"

o.bind("SUPER + SHIFT + D", "Baldborg: modo interactivo", baldborg .. " toggle")
o.bind("SUPER + SHIFT + M", "Baldborg: silenciar voz", baldborg .. " mute")
o.bind("SUPER + SHIFT + R", "Baldborg: repetir voz", baldborg .. " speak")

-- Start the overlay with the session (single-instance safe).
o.launch_on_start("__REPO__/bin/baldborg-start")
o.bind("SUPER + SHIFT + H", "Baldborg: ocultar", baldborg .. " hide")
