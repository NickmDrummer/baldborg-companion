export type UiLanguage = "es" | "en";

export interface UiStrings {
  idle: string;
  processing: string;
  warming: string;
  muted: string;
  voiceMuted: string;
  linkOpen: string;
  consulting: (tool: string) => string;
  empty: string;
  confirm: string;
  cancel: string;
  placeholder: string;
  placeholderBusy: string;
  placeholderListening: string;
  placeholderTranscribing: string;
  listening: string;
  transcribing: string;
}

const STRINGS: Record<UiLanguage, UiStrings> = {
  es: {
    idle: "EN ESPERA",
    processing: "PROCESANDO",
    warming: "CALENTANDO",
    muted: "SILENCIADO",
    voiceMuted: "VOZ SILENCIADA",
    linkOpen: "ENLACE ABIERTO",
    consulting: (tool) => `CONSULTANDO ${tool}`,
    empty: "Sistema en línea. Escriba su consulta y el núcleo responderá.",
    confirm: "Confirmar",
    cancel: "Cancelar",
    placeholder: "Escriba su consulta o /help, señor.",
    placeholderBusy: "El núcleo está respondiendo…",
    placeholderListening: "Escuchando, señor…",
    placeholderTranscribing: "Transcribiendo…",
    listening: "ESCUCHANDO…",
    transcribing: "TRANSCRIBIENDO…",
  },
  en: {
    idle: "STANDING BY",
    processing: "PROCESSING",
    warming: "WARMING UP",
    muted: "MUTED",
    voiceMuted: "VOICE MUTED",
    linkOpen: "LINK OPEN",
    consulting: (tool) => `CONSULTING ${tool}`,
    empty: "System online. Type your query and the core will answer.",
    confirm: "Confirm",
    cancel: "Cancel",
    placeholder: "Type your query or /help, sir.",
    placeholderBusy: "The core is replying…",
    placeholderListening: "Listening, sir…",
    placeholderTranscribing: "Transcribing…",
    listening: "LISTENING…",
    transcribing: "TRANSCRIBING…",
  },
};

export function ui(language: UiLanguage): UiStrings {
  return STRINGS[language] ?? STRINGS.es;
}

export const TOOL_LABELS: Record<UiLanguage, Record<string, string>> = {
  es: {
    get_weather: "CLIMA",
    set_reminder: "RECORDATORIO",
    team_fixtures: "EQUIPO",
    system_status: "SISTEMA",
    get_time: "HORA",
    epic_free_games: "EPIC",
    steam_free_games: "STEAM",
  },
  en: {
    get_weather: "WEATHER",
    set_reminder: "REMINDER",
    team_fixtures: "TEAM",
    system_status: "SYSTEM",
    get_time: "TIME",
    epic_free_games: "EPIC",
    steam_free_games: "STEAM",
  },
};
