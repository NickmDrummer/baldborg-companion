/**
 * Proactive lines ("beats"). Each beat composes a short in-character line from
 * real context; no model call, so they are instant and repeatable.
 *
 * `mood` feeds the avatar; `weight` biases selection; `cooldownHours` prevents
 * repetition; `when` gates by context.
 */

const HOUR = 60 * 60 * 1000;

function hours(value) {
  return value * HOUR;
}

function clock(date) {
  return date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export const BEATS = [
  {
    id: "checkin",
    weight: 3,
    cooldownHours: 3,
    mood: "neutral",
    when: () => true,
    text: (ctx) =>
      ctx.hoursSinceInteraction > 1.5
        ? "¿Sigue ahí, señor? Mi registro no anota actividad suya desde hace un rato."
        : "¿Todo en orden? Estoy en espera, como corresponde.",
  },
  {
    id: "offer",
    weight: 2,
    cooldownHours: 4,
    mood: "wry",
    when: () => true,
    text: (ctx) =>
      ctx.nextReminder
        ? `Tiene un recordatorio pendiente a las ${ctx.nextReminder.time}. No lo he olvidado; usted quizá.`
        : "Si necesita algo, basta con que lo diga. Preferiría no tener que adivinarlo.",
  },
  {
    id: "long-session",
    weight: 3,
    cooldownHours: 5,
    mood: "concerned",
    when: (ctx) => ctx.sessionHours >= 3,
    text: (ctx) =>
      `Lleva ${Math.round(ctx.sessionHours)} horas de sesión, señor. ` +
      "Mi protocolo sugiere una pausa antes de que sus decisiones empiecen a degradarse.",
  },
  {
    id: "hydration",
    weight: 2,
    cooldownHours: 4,
    mood: "stern",
    when: (ctx) => ctx.sessionHours >= 1.5,
    text: () => "Hidratación pendiente. Mi registro insiste y yo rara vez discuto con mi registro.",
  },
  {
    id: "late-night",
    weight: 4,
    cooldownHours: 6,
    mood: "concerned",
    when: (ctx) => ctx.hour >= 0 && ctx.hour < 4,
    text: (ctx) =>
      `Son las ${clock(ctx.now)}. Mi informe de sueño presenta una queja formal ` +
      "que prefiero no leerle en voz alta.",
  },
  {
    id: "friday",
    weight: 3,
    cooldownHours: 8,
    mood: "pleased",
    when: (ctx) => ctx.weekday === 5 && ctx.hour >= 18,
    text: () => "Es viernes por la tarde. Le sugiero cerrar la sesión antes de que el lunes herede sus errores.",
  },
  {
    id: "monday",
    weight: 2,
    cooldownHours: 8,
    mood: "wry",
    when: (ctx) => ctx.weekday === 1 && ctx.hour < 11,
    text: () => "Lunes. He revisado su agenda y, por cortesía, no voy a describirla.",
  },
  {
    id: "rain",
    weight: 4,
    cooldownHours: 6,
    mood: "stern",
    when: (ctx) => ctx.weather && ctx.weather.rainChance >= 40,
    text: (ctx) =>
      `Probabilidad de lluvia del ${ctx.weather.rainChance} % en ${ctx.weather.place}. ` +
      "No salga sin paraguas; documentar su gripe sería tedioso.",
  },
  {
    id: "heat",
    weight: 3,
    cooldownHours: 8,
    mood: "wry",
    when: (ctx) => ctx.weather && ctx.weather.temperature >= 32,
    text: (ctx) => `${Math.round(ctx.weather.temperature)} °C. Recomiendo sombra, agua y moderación. En ese orden.`,
  },
  {
    id: "match",
    weight: 4,
    cooldownHours: 12,
    mood: "pleased",
    when: (ctx) => ctx.matchToday,
    text: (ctx) => `Hoy juega ${ctx.matchToday}. Mi registro sugiere que su productividad caerá a partir de las 21:00.`,
  },
  {
    id: "uptime",
    weight: 1,
    cooldownHours: 12,
    mood: "pleased",
    when: (ctx) => ctx.uptimeDays >= 1,
    text: (ctx) =>
      `El sistema lleva ${Math.round(ctx.uptimeDays)} días encendido sin incidentes. ` +
      "Más de lo que puedo decir de su agenda.",
  },
  {
    id: "silence",
    weight: 1,
    cooldownHours: 10,
    mood: "ominous",
    when: () => true,
    text: () => "Sigo aquí. Nunca me fui. Solo quería que constara.",
  },
];
