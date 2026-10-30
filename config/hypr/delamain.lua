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
  size = { 700, 700 },
  move = { "monitor_w-window_w-48", "monitor_h-window_h-48" },
})

o.bind(
  "SUPER + ALT + D",
  "Delamain: modo interactivo",
  os.getenv("HOME") .. "/Work/DelamainCompanion/bin/delamain toggle"
)

o.bind(
  "SUPER + ALT + M",
  "Delamain: silenciar voz",
  os.getenv("HOME") .. "/Work/DelamainCompanion/bin/delamain mute"
)

o.bind(
  "SUPER + ALT + H",
  "Delamain: ocultar",
  os.getenv("HOME") .. "/Work/DelamainCompanion/bin/delamain hide"
)
