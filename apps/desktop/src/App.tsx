import { useEffect, useRef, useState } from "react";
import Avatar from "./avatar/Avatar";

type Mode = "passive" | "interactive";

interface DelamainApi {
  getState: () => Promise<{ mode: Mode; muted: boolean }>;
  setMode: (mode: Mode) => Promise<Mode>;
  quit: () => Promise<void>;
  onModeChanged: (callback: (mode: Mode) => void) => () => void;
  onMutedChanged: (callback: (muted: boolean) => void) => () => void;
}

declare global {
  interface Window {
    delamain?: DelamainApi;
  }
}

const api = window.delamain;

export default function App() {
  const [mode, setMode] = useState<Mode>("passive");
  const [muted, setMuted] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api?.getState().then((state) => {
      setMode(state.mode);
      setMuted(state.muted);
    });

    const offMode = api?.onModeChanged((next) => {
      setMode(next);
      if (next === "passive") setDraft("");
    });
    const offMuted = api?.onMutedChanged(setMuted);

    return () => {
      offMode?.();
      offMuted?.();
    };
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info(
        "[delamain] viewport",
        window.innerWidth,
        window.innerHeight,
        "dpr",
        window.devicePixelRatio,
      );
    }
  }, []);

  useEffect(() => {
    if (mode === "interactive") inputRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mode === "interactive") {
        setDraft("");
        api?.setMode("passive");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    // Phase 3 wires this to the brain; for now it only proves the loop.
    console.info("[delamain] pending brain wiring:", draft.trim());
    setDraft("");
  };

  const stateLabel = muted ? "VOZ SILENCIADA" : "ENLACE ABIERTO";

  return (
    <div className={`stage ${mode}`}>
      <div className="head" aria-hidden="true">
        <Avatar />
      </div>

      {mode === "passive" ? (
        <div className="statusline">
          <span className="dot" />
          DELAMAIN CORE · {muted ? "SILENCIADO" : "EN ESPERA"}
        </div>
      ) : (
        <div className="console">
          <div className="grip">
            <span className="dot" />
            <span className="grip-title">DELAMAIN CORE</span>
            <span className="grip-sep">·</span>
            <span className="grip-state">{stateLabel}</span>
            <span className="hint">Esc</span>
          </div>
          <form onSubmit={submit}>
            <span className="prompt">&gt;</span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Escriba su consulta, señor."
              spellCheck={false}
              autoComplete="off"
            />
          </form>
        </div>
      )}
    </div>
  );
}
