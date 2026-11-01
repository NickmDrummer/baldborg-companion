# Third-party notices

This project is an independent, unofficial piece of software. It is not
affiliated with, endorsed by, or sponsored by CD Projekt Red or any other game
studio. The personality is an original interpretation of the "corporate AI
butler" archetype; no dialogue, assets or trademarks are copied from any game.

## Head mesh

`apps/desktop/public/models/head.glb`

- "Lee Perry-Smith" head scan, by Infinite Realities Ltd.
- Source: three.js examples (`examples/models/gltf/LeePerrySmith`).
- License: Creative Commons Attribution 3.0 Unported (CC-BY 3.0).
- https://creativecommons.org/licenses/by/3.0/
- The mesh is scaled, clipped and re-shaded at runtime; no other changes.

## Text to speech

- Kokoro-82M weights and voices: Apache License 2.0
  (https://huggingface.co/hexgrad/Kokoro-82M).
- `kokoro-onnx` runtime: MIT License.
- `espeak-ng` data via `espeakng-loader`: GPL-3.0 (used as a separate library).

## Language models

Models are downloaded by the user with Ollama and keep their own licenses:

- Qwen3 (Apache License 2.0).
- Llama 3.2 (Llama 3.2 Community License).
- Model licences are supplied by the model publisher; review them before use.

## Data sources

- Open-Meteo (weather): free API, CC-BY 4.0 attribution required.
- TheSportsDB (fixtures): public API, free test key. Data belongs to
  TheSportsDB and its providers.
- dolarapi.com (exchange rates): public API; data belongs to its providers.
- Epic Games Store free-game promotions: public promotion feed; game titles,
  store links and artwork belong to Epic Games and the respective publishers.
- Steam Store search and app pages: public store data; game titles, store
  links and artwork belong to Valve and the respective publishers.

## Libraries

- three.js: MIT License.
- Electron: MIT License.
- React: MIT License.
- FastAPI / Uvicorn: MIT / BSD.
- faster-whisper / CTranslate2 / PyAV: MIT / MIT / BSD.
- Quickshell and the Omarchy shell (bar widget runtime): MIT / MIT.

## Fonts

The interface uses the system monospace font; no font files are bundled.
