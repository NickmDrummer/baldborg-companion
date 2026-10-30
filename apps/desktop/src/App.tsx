import { useEffect, useRef, useState } from "react";

type Mode = "passive" | "interactive";

interface DelamainApi {
  getState: () => Promise<{ mode: Mode; muted: boolean }>;
  setMode: (mode: Mode) => Promise<Mode>;
  setSize: (width: number, height: number) => Promise<void>;
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
      console.info("[delamain] mode ->", next);
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

  return (
    <div className={`stage ${mode}`}>
      <div className="head" aria-hidden="true">
        <div className="head-glow" />
        <div className="head-core">
          <div className="eye left" />
          <div className="eye right" />
          <div className="mouth" />
          <div className="scanlines" />
        </div>
      </div>

      <div className="statusline">
        <span className="dot" />
        DELAMAIN CORE · {mode === "interactive" ? "ENLACE ABIERTO" : "EN ESPERA"}
        {muted && " · VOZ SILENCIADA"}
      </div>

      {mode === "interactive" && (
        <div className="console">
          <div className="grip" />
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
            <span className="hint">Esc para cerrar</span>
          </form>
        </div>
      )}
    </div>
  );
}
