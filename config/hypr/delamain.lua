-- Delamain companion overlay (personal project, safe to remove)
-- Requires http://127.0.0.1:11434 (ollama) only when chatting.

o.window("^delamain-desktop$", {
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
o.window("^delamain-desktop$", {
  move = { "(monitor_w-200-24)", "(monitor_h-270-24)" },
})

-- These keys belong to Delamain now: SUPER+SHIFT+D was Docker and
-- SUPER+SHIFT+M was Music. Unbind first or Hyprland keeps the old action.
hl.unbind("SUPER + SHIFT + D")
hl.unbind("SUPER + SHIFT + H")
hl.unbind("SUPER + SHIFT + M")
hl.unbind("SUPER + SHIFT + R")

local delamain = os.getenv("HOME") .. "/Work/DelamainCompanion/bin/delamain"

o.bind("SUPER + SHIFT + D", "Delamain: modo interactivo", delamain .. " toggle")
o.bind("SUPER + SHIFT + M", "Delamain: silenciar voz", delamain .. " mute")
o.bind("SUPER + SHIFT + R", "Delamain: repetir voz", delamain .. " speak")
o.bind("SUPER + SHIFT + H", "Delamain: ocultar", delamain .. " hide")
