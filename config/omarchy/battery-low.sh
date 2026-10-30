#!/usr/bin/env bash
# Omarchy battery-low hook. $1 is the battery percentage.
# On desktops this hook never fires; it is harmless to keep installed.
exec "__REPO__/bin/baldborg" announce "Batería al ${1:-?} por ciento, señor. Le sugiero un enchufe antes de que mi protocolo tenga que intervenir."
