import { useEffect, useRef, useState } from "react";
import Avatar from "./avatar/Avatar";
import type { HeadMaterial } from "./avatar/bust";
import type { Mood } from "./avatar/createAvatar";
import { requestGlitch } from "./avatar/effects";
import { createSpeaker } from "./voice/speaker";

type Mode = "passive" | "interactive";
type Role = "user" | "assistant" | "error";

interface ChatEntry {
  id: number;
  role: Role;
  text: string;
  mood?: Mood;
}

interface BrainEvent {
  type: "chunk" | "done" | "error" | "reset";
  text?: string;
  mood?: Mood;
  message?: string;
  hint?: string;
  cancelled?: boolean;
}

interface DelamainApi {
  getState: () => Promise<{
    mode: Mode;
    muted: boolean;
    autoSpeak?: boolean;
    material?: HeadMaterial;
  }>;
  setMode: (mode: Mode) => Promise<Mode>;
  quit: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  cancelChat: () => Promise<void>;
  speak: (text: string) => Promise<{ wav: Uint8Array; lang: string } | null>;
  onVoiceReplay: (callback: () => void) => () => void;
  onGlitch: (callback: () => void) => () => void;
  getHistory: () => Promise<{ role: Role; content: string }[]>;
  resetMemory: () => Promise<void>;
  onModeChanged: (callback: (mode: Mode) => void) => () => void;
  onMutedChanged: (callback: (muted: boolean) => void) => () => void;
  onBrainEvent: (callback: (event: BrainEvent) => void) => () => void;
}

declare global {
  interface Window {
    delamain?: DelamainApi;
  }
}

const api = window.delamain;
const TAG_RE = /^\s*\[\[mood:\s*([a-z]+)\s*\]\]\s*/i;

/** Hide the machine-readable mood tag while the reply streams in. */
function visibleText(raw: string) {
  return raw.replace(TAG_RE, "");
}

let nextId = 1;

export default function App() {
  const [mode, setMode] = useState<Mode>("passive");
  const [muted, setMuted] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<Mood>("neutral");
  const [material, setMaterial] = useState<HeadMaterial>("normal");

  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const streamingId = useRef<number | null>(null);
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null);
  const mutedRef = useRef(false);
  const autoSpeakRef = useRef(true);
  const lastReply = useRef("");

  const speakText = async (text: string) => {
    if (mutedRef.current || !text) return;
    const result = await api?.speak(text);
    if (!result) return;
    const bytes = new Uint8Array(result.wav);
    await speaker.current?.speak(bytes.buffer);
  };

  useEffect(() => {
    speaker.current = createSpeaker();
    return () => speaker.current?.stop();
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
    speaker.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    api?.getState().then((state) => {
      setMode(state.mode);
      setMuted(state.muted);
      autoSpeakRef.current = state.autoSpeak ?? true;
      if (state.material) setMaterial(state.material);
    });

    api?.getHistory().then((history) => {
      setEntries(
        history.map((entry) => ({
          id: nextId++,
          role: entry.role,
          text: entry.content,
        })),
      );
    });

    const offMode = api?.onModeChanged((next) => {
      setMode(next);
      if (next === "passive") {
        setDraft("");
        speaker.current?.stop();
      }
    });
    const offMuted = api?.onMutedChanged(setMuted);

    const offGlitch = api?.onGlitch(() => requestGlitch());
    const offReplay = api?.onVoiceReplay(() => {
      if (lastReply.current) void speakText(lastReply.current);
    });

    const offBrain = api?.onBrainEvent((event) => {
      if (event.type === "reset") {
        streamingId.current = null;
        setBusy(false);
        setEntries([]);
        return;
      }

      if (event.type === "chunk") {
        const id = streamingId.current;
        if (id === null) return;
        setEntries((current) =>
          current.map((entry) =>
            entry.id === id ? { ...entry, text: entry.text + (event.text ?? "") } : entry,
          ),
        );
        return;
      }

      if (event.type === "done") {
        const id = streamingId.current;
        streamingId.current = null;
        setBusy(false);
        if (event.mood) setMood(event.mood);
        setEntries((current) =>
          current
            .map((entry) =>
              entry.id === id
                ? { ...entry, text: event.cancelled ? entry.text : (event.text ?? entry.text) }
                : entry,
            )
            .filter((entry) => entry.role !== "assistant" || entry.text.trim().length > 0),
        );

        if (!event.cancelled && event.text) {
          lastReply.current = event.text;
          if (autoSpeakRef.current) void speakText(event.text);
        }
        return;
      }

      if (event.type === "error") {
        const id = streamingId.current;
        streamingId.current = null;
        setBusy(false);
        setEntries((current) =>
          current.map((entry) =>
            entry.id === id
              ? { ...entry, role: "error" as Role, text: event.hint ?? "Error de enlace." }
              : entry,
          ),
        );
      }
    });

    return () => {
      offMode?.();
      offMuted?.();
      offReplay?.();
      offGlitch?.();
      offBrain?.();
    };
  }, []);

  useEffect(() => {
    if (mode !== "interactive") return;
    inputRef.current?.focus();
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mode, entries]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || mode !== "interactive") return;
      if (busy) {
        window.delamain?.cancelChat();
        return;
      }
      setDraft("");
      window.delamain?.setMode("passive");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, busy]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;

    const assistantId = nextId++;
    streamingId.current = assistantId;
    setEntries((current) => [
      ...current,
      { id: nextId++, role: "user", text },
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setDraft("");
    setBusy(true);
    api?.sendMessage(text);
  };

  return (
    <div className={`stage ${mode}`}>
      <div className="head" aria-hidden="true">
        <Avatar mood={mood} material={material} />
      </div>

      {mode === "passive" ? (
        <div className="statusline">
          <span className="dot" />
          DELAMAIN CORE · {muted ? "SILENCIADO" : busy ? "PROCESANDO" : "EN ESPERA"}
        </div>
      ) : (
        <div className="console">
          <div className="grip">
            <span className="dot" />
            <span className="grip-title">DELAMAIN CORE</span>
            <span className="grip-sep">·</span>
            <span className="grip-state">
              {muted ? "VOZ SILENCIADA" : busy ? "PROCESANDO" : "ENLACE ABIERTO"}
            </span>
            <span className="hint">Esc</span>
          </div>

          <div className="transcript" ref={transcriptRef}>
            {entries.length === 0 && (
              <p className="entry hint-line">
                Sistema en línea. Escriba su consulta y el núcleo responderá.
              </p>
            )}
            {entries.map((entry) => (
              <p key={entry.id} className={`entry ${entry.role}`}>
                <span className="mark">{entry.role === "user" ? ">" : "◆"}</span>
                <span className="body">
                  {entry.role === "assistant" ? visibleText(entry.text) : entry.text}
                  {entry.role === "assistant" && busy && entry.id === streamingId.current && (
                    <span className="cursor">▌</span>
                  )}
                </span>
              </p>
            ))}
          </div>

          <form onSubmit={submit}>
            <span className="prompt">&gt;</span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={busy ? "El núcleo está respondiendo…" : "Escriba su consulta, señor."}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </form>
        </div>
      )}
    </div>
  );
}
