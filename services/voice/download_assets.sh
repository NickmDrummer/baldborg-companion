#!/usr/bin/env bash
# Download the Kokoro weights used by the voice sidecar.
# They are not committed to git because of their size (~340 MB).
set -euo pipefail

ASSETS_DIR="$(cd "$(dirname "$0")" && pwd)/assets/models"
mkdir -p "$ASSETS_DIR"
cd "$ASSETS_DIR"

BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

for file in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [[ -f "$file" ]]; then
    echo "already present: $file"
    continue
  fi
  echo "downloading $file"
  curl -fL --retry 3 -o "$file" "$BASE/$file"
done

ls -lh
