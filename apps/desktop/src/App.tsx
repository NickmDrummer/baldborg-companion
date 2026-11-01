import { useEffect, useRef, useState } from "react";
import Avatar from "./avatar/Avatar";
import type { HeadMaterial } from "./avatar/bust";
import type { Mood } from "./avatar/createAvatar";
import { requestCalm, requestGlitch } from "./avatar/effects";
import { createSpeaker, type EffectsPreset } from "./voice/speaker";
import { TOOL_LABELS, ui, type UiLanguage } from "./i18n";

type Mode = "passive" | "interactive";
type ChatSide = "left" | "right" | "stacked";
type Role = "user" | "assistant" | "error";

interface ChatEntry {
  id: number;
  role: Role;
  text: string;
  mood?: Mood;
}

interface BrainEvent {
  type:
    | "chunk"
    | "done"
    | "error"
    | "reset"
    | "tool"
    | "discard"
    | "confirm"
    | "confirm-cancel"
    | "voice";
  text?: string;
  mood?: Mood;
  message?: string;
  hint?: string;
  cancelled?: boolean;
  name?: string;
  status?: "running" | "done";
  id?: string;
  summary?: string;
}

interface BeatEvent {
  type: "beat";
  id: string;
  text: string;
  mood: Mood;
  speak: boolean;
  durationMs?: number;
}

type ListenPhase = "recording" | "transcribing";

interface ListenState {
  active: boolean;
  phase?: ListenPhase;
}

interface BaldborgApi {
  getState: () => Promise<{
    mode: Mode;
    layout?: ChatSide;
    muted: boolean;
    autoSpeak?: boolean;
    effects?: EffectsPreset;
    language?: UiLanguage;
    material?: HeadMaterial;
    accent?: string;
  }>;
  setMode: (mode: Mode) => Promise<Mode>;
  quit: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  runTask: (kind: "translate" | "correct", text: string, target?: "es" | "en") => Promise<void>;
  cancelChat: () => Promise<void>;
  confirmTool: (id: string, accepted: boolean) => Promise<boolean>;
  speak: (text: string) => Promise<{ wav: Uint8Array; lang: string } | null>;
  onVoiceReplay: (callback: () => void) => () => void;
  onGlitch: (callback: () => void) => () => void;
  onWindowFocus: (callback: () => void) => () => void;
  onAccent: (callback: (color: string) => void) => () => void;
  onWarm: (callback: (active: boolean) => void) => () => void;
  onLocked: (callback: (locked: boolean) => void) => () => void;
  onBeat: (callback: (beat: BeatEvent) => void) => () => void;
  onListenState: (callback: (state: ListenState) => void) => () => void;
  getHistory: () => Promise<{ role: Role; content: string }[]>;
  resetMemory: () => Promise<void>;
  runCommand: (text: string) => Promise<{ ok: boolean; message: string; reset?: boolean }>;
  beginDrag: () => void;
  dragTo: () => void;
  endDrag: () => void;
  onModeChanged: (callback: (mode: Mode, side?: ChatSide) => void) => () => void;
  onMutedChanged: (callback: (muted: boolean) => void) => () => void;
  onAutoSpeak: (callback: (value: boolean) => void) => () => void;
  onMaterial: (callback: (value: HeadMaterial) => void) => () => void;
  onEffects: (callback: (value: EffectsPreset) => void) => () => void;
  onLanguage: (callback: (value: UiLanguage) => void) => () => void;
  onBrainEvent: (callback: (event: BrainEvent) => void) => () => void;
}

declare global {
  interface Window {
    baldborg?: BaldborgApi;
  }
}

const api = window.baldborg;
const TAG_RE = /^\s*\[\[mood:\s*([a-z]+)\s*\]\]\s*/i;

/** Hide the machine-readable mood tag while the reply streams in. */
function visibleText(raw: string) {
  return raw.replace(TAG_RE, "");
}

function applyAccent(color: string) {
  const root = document.documentElement;
  root.style.setProperty("--holo", color);
  const match = color.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (match) {
    const [, r, g, b] = match;
    root.style.setProperty("--glow", `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, 0.38)`);
  }
}

interface TextTask {
  kind: "translate" | "correct";
  body: string;
  target?: "es" | "en";
}

/** `/translate [es|en] text` and `/correct text` use the local model directly. */
function parseTextTask(text: string): TextTask | null {
  const match = text.match(/^\/(translate|correct)\b\s*([\s\S]*)$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase() as "translate" | "correct";
  let body = match[2].trim();
  let target: "es" | "en" | undefined;
  if (kind === "translate") {
    const language = body.match(/^(es|en)\b\s*/i);
    if (language) {
      target = language[1].toLowerCase() as "es" | "en";
      body = body.slice(language[0].length).trim();
    }
  }
  return { kind, body, target };
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
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; summary: string } | null>(null);
  const [beat, setBeat] = useState<{ text: string; mood: Mood } | null>(null);
  const [listenPhase, setListenPhase] = useState<ListenPhase | null>(null);
  const [language, setLanguage] = useState<UiLanguage>("es");
  const [chatSide, setChatSide] = useState<ChatSide>("stacked");
  const beatTimer = useRef<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const streamingId = useRef<number | null>(null);
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null);
  const mutedRef = useRef(false);
  const autoSpeakRef = useRef(true);
  const lastReply = useRef("");
  const modeRef = useRef<Mode>("passive");
  const t = ui(language);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

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
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    mutedRef.current = muted;
    speaker.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    api?.getState().then((state) => {
      setMode(state.mode);
      if (state.layout) setChatSide(state.layout);
      setMuted(state.muted);
      autoSpeakRef.current = state.autoSpeak ?? true;
      if (state.language) setLanguage(state.language);
      if (state.effects) speaker.current?.setEffects(state.effects);
      if (state.material) setMaterial(state.material);
      if (state.accent) applyAccent(state.accent);
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

    const offMode = api?.onModeChanged((next, side) => {
      setMode(next);
      if (side) setChatSide(side);
      if (next === "interactive") setBeat(null);
      if (next === "passive") {
        setDraft("");
        speaker.current?.stop();
      }
    });
    const offMuted = api?.onMutedChanged(setMuted);
    const offAutoSpeak = api?.onAutoSpeak((value) => {
      autoSpeakRef.current = value;
    });
    const offMaterial = api?.onMaterial((value) => setMaterial(value));
    const offEffects = api?.onEffects((value) => speaker.current?.setEffects(value));
    const offLanguage = api?.onLanguage((value) => setLanguage(value));

    const offWindowFocus = api?.onWindowFocus(() => {
      if (modeRef.current === "interactive") inputRef.current?.focus();
    });
    const offAccent = api?.onAccent((color) => applyAccent(color));
    const offWarm = api?.onWarm((active) => setWarming(active));
    const offLocked = api?.onLocked((value) => setLocked(value));

    const offBeat = api?.onBeat((event) => {
      setMood(event.mood);
      if (event.speak && !mutedRef.current) void speakText(event.text);

      // With the chat open there is no bubble, so the line goes to the
      // transcript; otherwise it floats under the head.
      if (modeRef.current === "interactive") {
        setEntries((current) => [
          ...current,
          { id: nextId++, role: "assistant", text: event.text },
        ]);
        return;
      }

      setBeat({ text: event.text, mood: event.mood });
      if (beatTimer.current) window.clearTimeout(beatTimer.current);
      // Reminders stay a little longer: they matter more than a passing beat.
      const duration = event.durationMs ?? (event.id?.startsWith("reminder-") ? 30_000 : 20_000);
      beatTimer.current = window.setTimeout(() => setBeat(null), duration);
    });

    const offListen = api?.onListenState((state) => {
      setListenPhase(state.active ? (state.phase ?? "recording") : null);
    });

    const offGlitch = api?.onGlitch(() => {
      requestGlitch();
      requestCalm(700);
    });
    const offReplay = api?.onVoiceReplay(() => {
      if (lastReply.current) void speakText(lastReply.current);
    });

    const offBrain = api?.onBrainEvent((event) => {
      if (event.type === "discard") {
        const id = streamingId.current;
        if (id === null) return;
        setEntries((current) =>
          current.map((entry) => (entry.id === id ? { ...entry, text: "" } : entry)),
        );
        return;
      }

      if (event.type === "tool") {
        setActiveTool(event.status === "running" ? (event.name ?? null) : null);
        return;
      }

      if (event.type === "confirm") {
        setPendingConfirm({ id: event.id ?? "", summary: event.summary ?? "" });
        return;
      }

      if (event.type === "confirm-cancel") {
        setPendingConfirm(null);
        return;
      }

      if (event.type === "voice") {
        const text = event.text?.trim();
        if (!text) return;
        const userId = nextId++;
        const assistantId = nextId++;
        streamingId.current = assistantId;
        setEntries((current) => [
          ...current,
          { id: userId, role: "user", text },
          { id: assistantId, role: "assistant", text: "" },
        ]);
        setBusy(true);
        return;
      }

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
        setActiveTool(null);
        setPendingConfirm(null);
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
      offAutoSpeak?.();
      offMaterial?.();
      offEffects?.();
      offLanguage?.();
      offReplay?.();
      offGlitch?.();
      offBeat?.();
      offListen?.();
      offWindowFocus?.();
      offAccent?.();
      offWarm?.();
      offLocked?.();
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
      if (pendingConfirm) {
        if (event.key === "Enter") {
          event.preventDefault();
          void api?.confirmTool(pendingConfirm.id, true);
          setPendingConfirm(null);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          void api?.confirmTool(pendingConfirm.id, false);
          setPendingConfirm(null);
          return;
        }
      }

      if (event.key !== "Escape" || mode !== "interactive") return;
      if (busy) {
        window.baldborg?.cancelChat();
        return;
      }
      setDraft("");
      window.baldborg?.setMode("passive");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, busy, pendingConfirm]);

  const executeCommand = async (text: string) => {
    const result = await api?.runCommand(text);
    if (!result) return;
    if (result.reset) {
      streamingId.current = null;
      setBusy(false);
      setPendingConfirm(null);
      setActiveTool(null);
      setEntries([{ id: nextId++, role: "assistant", text: result.message }]);
      return;
    }
    setEntries((current) => [
      ...current,
      { id: nextId++, role: "user", text },
      { id: nextId++, role: "assistant", text: result.message },
    ]);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    const task = parseTextTask(text);
    if (task) {
      if (!task.body) {
        setDraft("");
        void executeCommand(text);
        return;
      }
      if (busy) return;
      const assistantId = nextId++;
      streamingId.current = assistantId;
      setEntries((current) => [
        ...current,
        { id: nextId++, role: "user", text },
        { id: assistantId, role: "assistant", text: "" },
      ]);
      setDraft("");
      setBusy(true);
      const target = task.target ?? (language === "es" ? "en" : "es");
      void api?.runTask(task.kind, task.body, target);
      return;
    }

    if (text.startsWith("/")) {
      setDraft("");
      void executeCommand(text);
      return;
    }
    if (busy) return;

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
    <div
      className={`stage ${mode}${
        mode === "interactive" ? ` side-${chatSide === "stacked" ? "right" : chatSide}` : ""
      }${locked ? " locked" : ""}`}
    >
      <div className="head" aria-hidden="true">
        <Avatar key={material} mood={mood} material={material} />
      </div>

      {mode === "passive" ? (
        listenPhase ? (
          <div className="beat listening">
            {listenPhase === "recording" ? t.listening : t.transcribing}
          </div>
        ) : beat ? (
          <div className="beat">{beat.text}</div>
        ) : (
          <div className="statusline">
            <span className="pill-grip" aria-hidden="true">⠿</span>
            <span className="dot" />
            BALDBORG ·{" "}
            {muted ? t.muted : busy ? t.processing : warming ? t.warming : t.idle}
          </div>
        )
      ) : (
        <div className="console">
          <div
            className="grip"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = true;
              api?.beginDrag();
            }}
            onPointerMove={() => {
              if (!dragging.current) return;
              api?.dragTo();
            }}
            onPointerUp={(event) => {
              if (!dragging.current) return;
              dragging.current = false;
              event.currentTarget.releasePointerCapture(event.pointerId);
              api?.endDrag();
            }}
            onPointerCancel={() => {
              if (!dragging.current) return;
              dragging.current = false;
              api?.endDrag();
            }}
          >
            <span className="dot" />
            <span className="grip-title">BALDBORG</span>
            <span className="grip-sep">·</span>
            <span className="grip-state">
              {listenPhase === "recording"
                ? "ESCUCHANDO"
                : listenPhase === "transcribing"
                  ? "TRANSCRIBIENDO"
                  : muted
                ? t.voiceMuted
                : busy
                  ? activeTool
                    ? t.consulting(TOOL_LABELS[language][activeTool] ?? activeTool.toUpperCase())
                    : t.processing
                  : warming
                    ? t.warming
                    : t.linkOpen}
            </span>
            <span className="hint">Esc</span>
          </div>

          <div className="transcript" ref={transcriptRef}>
            {entries.length === 0 && (
              <p className="entry hint-line">
                {t.empty}
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

          {pendingConfirm && (
            <div className="confirm">
              <span className="confirm-text">{pendingConfirm.summary}</span>
              <button
                type="button"
                className="confirm-yes"
                onClick={() => {
                  void api?.confirmTool(pendingConfirm.id, true);
                  setPendingConfirm(null);
                }}
              >
                {t.confirm}
              </button>
              <button
                type="button"
                className="confirm-no"
                onClick={() => {
                  void api?.confirmTool(pendingConfirm.id, false);
                  setPendingConfirm(null);
                }}
              >
                {t.cancel}
              </button>
            </div>
          )}

          <form onSubmit={submit}>
            <span className="prompt">&gt;</span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                listenPhase === "recording"
                  ? t.placeholderListening
                  : listenPhase === "transcribing"
                    ? t.placeholderTranscribing
                    : busy
                      ? t.placeholderBusy
                      : t.placeholder
              }
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
