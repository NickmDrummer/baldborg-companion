#!/usr/bin/env bash
# Omarchy post-update hook: one dry line from Baldborg after updates.
exec "__REPO__/bin/baldborg" announce "Actualización aplicada. Nada se ha roto, esta vez."
