#!/usr/bin/env node
/**
 * Regression checks for the parts that broke before: fixture time zones,
 * language detection, slash-command parsing and the reminder-quip filters.
 *
 * Run with: node scripts/checks.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  convertUnits,
  formatEpicSummary,
  formatFixture,
  formatSteamFreeGames,
  parseConversionQuery,
  parseCurrencyQuery,
  parseIcsEvents,
  parseSteamFreeKeepPage,
  parseSteamSearch,
} from "../apps/desktop/electron/tools.js";
import {
  epicBeatText,
  epicTitles,
  newEpicTitles,
  nextEpicCheck,
} from "../apps/desktop/electron/epic.js";
import { detectLanguage, resolveVoiceLanguage } from "../apps/desktop/electron/voice.js";
import {
  parseBeatInterval,
  parseCommand,
  parseSilentHours,
  parseToggle,
} from "../apps/desktop/electron/commands.js";
import { nextIntervalMinutes } from "../apps/desktop/electron/beats.js";
import { isAcceptableQuip } from "../apps/desktop/electron/quip.js";
import {
  normaliseKey,
  parseFact,
  parseMemoryIntent,
} from "../apps/desktop/electron/memory.js";

const ARGENTINA = "America/Argentina/Buenos_Aires";

function fixture(timestamp, overrides = {}) {
  return {
    strEvent: "Bayern Munich vs Borussia Dortmund",
    strLeague: "German Bundesliga",
    strTimestamp: timestamp,
    dateEvent: timestamp.slice(0, 10),
    ...overrides,
  };
}

test("fixture converts UTC to Argentina time", () => {
  const match = formatFixture(fixture("2026-10-31T17:30:00"), ARGENTINA);
  assert.equal(match.whenIso, "2026-10-31T17:30:00.000Z");
  assert.match(match.when, /14:30/);
  assert.match(match.whenEn, /14:30/);
  assert.match(match.when, /31/);
});

test("fixture handles a match that is the previous day in Argentina", () => {
  const match = formatFixture(fixture("2026-10-31T00:15:00"), ARGENTINA);
  assert.match(match.when, /21:15/);
  assert.match(match.when, /30/);
});

test("fixture formatting does not invent a time for missing timestamps", () => {
  const match = formatFixture({ strEvent: "Test", dateEvent: "2026-11-01" }, ARGENTINA);
  assert.equal(match.whenIso, null);
  assert.equal(match.when, "2026-11-01");
});

test("language detection handles short English and Spanish messages", () => {
  assert.equal(detectLanguage("When does Bayern play next?"), "en");
  assert.equal(detectLanguage("What is the weather in Rosario?"), "en");
  assert.equal(detectLanguage("Remind me to check the build"), "en");
  assert.equal(detectLanguage("¿Cómo está el clima en Rosario?"), "es");
  assert.equal(detectLanguage("Recuérdame llamar a mamá"), "es");
  assert.equal(detectLanguage("fútbol"), "es");
});

test("slash commands keep arguments with spaces", () => {
  assert.deepEqual(parseCommand("/club Bayern Munich"), {
    command: "/club",
    argument: "Bayern Munich",
  });
  assert.deepEqual(parseCommand("  /MUTE off "), { command: "/mute", argument: "off" });
  assert.deepEqual(parseCommand("/help"), { command: "/help", argument: "" });
});

test("toggle parsing is explicit and rejects unknown values", () => {
  assert.equal(parseToggle("", true), false);
  assert.equal(parseToggle("", false), true);
  assert.equal(parseToggle("off", true), false);
  assert.equal(parseToggle("on", false), true);
  assert.equal(parseToggle("sí", false), true);
  assert.equal(parseToggle("quizá", true), null);
});

test("quip validation accepts a contextual line", () => {
  const quip =
    "Usted no posterga el informe; posterga el momento en que alguien lo lea.";
  assert.equal(isAcceptableQuip(quip, "revisar el informe", "es"), true);
});

test("quip validation rejects numbers, tuteo, filler and placeholders", () => {
  const base = "Usted no posterga el informe; ";
  assert.equal(
    isAcceptableQuip(`${base}posterga el 80 % de la culpa.`, "revisar el informe", "es"),
    false,
  );
  assert.equal(
    isAcceptableQuip(`${base}posterga tu culpa.`, "revisar el informe", "es"),
    false,
  );
  assert.equal(
    isAcceptableQuip(`${base}posterga la prioridad.`, "revisar el informe", "es"),
    false,
  );
  assert.equal(
    isAcceptableQuip(`${base}posterga la verdad incómoda.`, "revisar el informe", "es"),
    false,
  );
  assert.equal(isAcceptableQuip("La culpa no se cura.", "revisar el informe", "es"), false);
});

test("quip validation rejects a verbatim example", () => {
  const example = "Usted no posterga el informe; posterga el momento en que alguien lo lea.";
  assert.equal(
    isAcceptableQuip(example, "revisar el informe", "es", [example]),
    false,
  );
});

test("beat cadence parses fixed minutes and random", () => {
  assert.deepEqual(parseBeatInterval("30"), { minutes: 30 });
  assert.deepEqual(parseBeatInterval("every 15"), { minutes: 15 });
  assert.deepEqual(parseBeatInterval("cada 5"), { minutes: 5 });
  assert.deepEqual(parseBeatInterval("random"), { random: true });
  assert.deepEqual(parseBeatInterval("every random"), { random: true });
  assert.deepEqual(parseBeatInterval("0"), { random: true });
  assert.equal(parseBeatInterval("on"), null);
  assert.equal(parseBeatInterval("300"), null);
  assert.equal(parseBeatInterval("quizá"), null);
});

test("scheduler honours a fixed interval and falls back to a range", () => {
  assert.equal(nextIntervalMinutes({ everyMinutes: 30, minMinutes: 20, maxMinutes: 45 }), 30);
  const random = nextIntervalMinutes({ everyMinutes: 0, minMinutes: 20, maxMinutes: 45 });
  assert.ok(random >= 20 && random <= 45);
});

test("silent hours parse ranges and off", () => {
  assert.deepEqual(parseSilentHours("23-8"), { start: 23, end: 8 });
  assert.deepEqual(parseSilentHours("23:00-08:00"), { start: 23, end: 8 });
  assert.deepEqual(parseSilentHours("off"), { start: 0, end: 0 });
  assert.equal(parseSilentHours("24-8"), null);
  assert.equal(parseSilentHours("noche"), null);
});

test("remember parses key/value facts and normalizes keys", () => {
  assert.deepEqual(parseFact("nombre = Nicolás"), { key: "nombre", value: "Nicolás" });
  assert.deepEqual(parseFact("Ciudad: Rosario"), { key: "ciudad", value: "Rosario" });
  assert.equal(normaliseKey("Color favorito"), "color_favorito");
  assert.equal(normaliseKey("  ¿Cómo estás?  "), "como_estas");
});

test("remember rejects missing separators and credentials", () => {
  assert.ok(parseFact("sin separador").error);
  assert.ok(parseFact("password = hunter2").error);
  assert.ok(parseFact("nota = abcdefghijklmnopqrstuvwxyz123456").error);
});

test("remember collapses whitespace in values", () => {
  const fact = parseFact("nota = primera línea\nsegunda línea");
  assert.equal(fact.value, "primera línea segunda línea");
});

test("natural memory understands save, forget and list", () => {
  assert.deepEqual(parseMemoryIntent("recuerda que mi color favorito es el azul"), {
    action: "save",
    key: "color_favorito",
    value: "azul",
  });
  assert.deepEqual(parseMemoryIntent("remember that my favorite color is blue"), {
    action: "save",
    key: "favorite_color",
    value: "blue",
  });
  assert.deepEqual(parseMemoryIntent("olvida mi color favorito"), {
    action: "forget",
    key: "color_favorito",
  });
  assert.deepEqual(parseMemoryIntent("¿Qué recuerdas de mí?"), { action: "list" });
  assert.equal(parseMemoryIntent("hola, ¿cómo estás?"), null);
});

test("unit conversion handles metric, imperial and temperature", () => {
  const km = convertUnits({ value: 10, from: "km", to: "mi" });
  assert.equal(km.value.toFixed(3), "6.214");
  assert.match(km.summary, /10 km = 6\.214 mi/);
  const f = convertUnits({ value: 100, from: "°F", to: "°C" });
  assert.equal(f.value.toFixed(3), "37.778");
  assert.match(f.summary, /100 °F = 37\.778 °C/);
  assert.throws(() => convertUnits({ value: 1, from: "kg", to: "km" }), /cannot convert/);
});

test("natural conversion queries parse direct and reverse wording", () => {
  assert.deepEqual(parseConversionQuery("convert 70 kg to pounds"), {
    value: 70,
    from: "kg",
    to: "lb",
  });
  assert.deepEqual(parseConversionQuery("¿cuántas millas son 10 kilómetros?"), {
    value: 10,
    from: "km",
    to: "mi",
  });
  assert.deepEqual(parseConversionQuery("2 galones a litros"), {
    value: 2,
    from: "gal",
    to: "l",
  });
});

test("currency queries pick house, amount and direction", () => {
  assert.deepEqual(parseCurrencyQuery("¿a cuánto está el dólar blue?"), {
    currency: "USD",
    house: "blue",
  });
  assert.deepEqual(parseCurrencyQuery("100 dólares a pesos"), {
    currency: "USD",
    amount: 100,
    direction: "to_ars",
  });
  assert.deepEqual(parseCurrencyQuery("¿cuántos dólares son 150000 pesos?"), {
    currency: "USD",
    amount: 150000,
    direction: "from_ars",
  });
  assert.equal(parseCurrencyQuery("¿cómo está el clima?"), null);
});

test("ics parser reads all-day and recurring events", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261102",
    "SUMMARY:Dentist",
    "LOCATION:Centro",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART:20260101T180000",
    "DTEND:20260101T190000",
    "RRULE:FREQ=WEEKLY;INTERVAL=1",
    "SUMMARY:Standup",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");
  const events = parseIcsEvents(ics, new Date("2026-11-30T23:59:59Z"));
  const dentist = events.find((event) => event.title === "Dentist");
  assert.equal(dentist.allDay, true);
  assert.equal(dentist.location, "Centro");
  const standups = events.filter((event) => event.title === "Standup");
  assert.ok(standups.length >= 4);
  assert.ok(standups.every((event) => event.start.getDay() === 4));
});

test("Epic checks jump to the next Thursday at 13:05", () => {
  const wednesday = new Date(2026, 10, 4, 12, 0, 0); // Wed 4 Nov 2026
  const next = nextEpicCheck(wednesday);
  assert.equal(next.getDay(), 4);
  assert.equal(next.getHours(), 13);
  assert.equal(next.getMinutes(), 5);
  assert.ok(next > wednesday);

  const thursdayBefore = new Date(2026, 10, 5, 12, 0, 0);
  assert.equal(nextEpicCheck(thursdayBefore).getDate(), 5);

  const thursdayAfter = new Date(2026, 10, 5, 14, 0, 0);
  assert.equal(nextEpicCheck(thursdayAfter).getDate(), 12);
});

test("Epic title diff only reports new games", () => {
  const current = epicTitles([{ title: "B" }, { title: "A" }, { title: "A" }]);
  assert.deepEqual(current, ["A", "B"]);
  assert.deepEqual(newEpicTitles(["A"], current), ["B"]);
  assert.deepEqual(newEpicTitles(["A", "B"], current), []);
  assert.equal(
    epicBeatText(["A", "B"], "es"),
    "Nuevos juegos gratis en Epic: A, B.",
  );
  assert.equal(
    epicBeatText(["A", "B"], "en"),
    "New free games on Epic: A, B.",
  );
});

test("Epic summary uses quotes and day/month dates", () => {
  const current = [
    { title: "Sorry We're Closed", endLabel: "5 nov", endLabelEn: "5 Nov" },
  ];
  const upcoming = [
    { title: "Idle Champions", startLabel: "5 nov", startLabelEn: "5 Nov" },
    { title: "Flotsam", startLabel: "5 nov", startLabelEn: "5 Nov" },
  ];
  assert.equal(
    formatEpicSummary(current, upcoming, false),
    'Gratis en Epic ahora: "Sorry We\'re Closed" (hasta 5 nov). Próximamente: "Idle Champions", "Flotsam" (5 nov).',
  );
  assert.equal(
    formatEpicSummary(
      current.map((game) => ({ ...game, endLabel: game.endLabelEn })),
      upcoming.map((game) => ({ ...game, startLabel: game.startLabelEn })),
      true,
    ),
    'Free on Epic now: "Sorry We\'re Closed" (Until 5 Nov). Coming soon: "Idle Champions", "Flotsam" (5 Nov).',
  );
});

test("Steam free-to-keep parser keeps only limited 100% promotions", () => {
  const search = parseSteamSearch({
    results_html:
      '<a data-ds-appid="1583850"><span class="title">Asleep: Act 1</span><div>-100%</div></a>' +
      '<a data-ds-appid="123"><span class="title">Free Forever</span></a>',
  });
  assert.deepEqual(search.map((game) => game.id), ["1583850"]);

  const paid = parseSteamFreeKeepPage(
    '&quot;is_free_to_keep&quot;:1,&quot;free_to_keep_ends&quot;:1793642400',
  );
  assert.equal(paid.toISOString(), "2026-11-02T18:00:00.000Z");
  assert.equal(parseSteamFreeKeepPage('&quot;is_free&quot;:1'), null);
  assert.equal(parseSteamFreeKeepPage('&quot;is_free_to_keep&quot;:1'), null);
});

test("Steam summary quotes titles and only shows the end date", () => {
  const games = [
    { title: "Asleep: Act 1", endLabel: "2 nov", endLabelEn: "2 Nov" },
  ];
  assert.equal(
    formatSteamFreeGames(games, false),
    'Gratis para reclamar en Steam: "Asleep: Act 1" (hasta 2 nov).',
  );
  assert.equal(
    formatSteamFreeGames(games, true),
    'Free to keep on Steam: "Asleep: Act 1" (Until 2 Nov).',
  );
});

test("voice language follows the interface, not the message text", () => {
  assert.equal(resolveVoiceLanguage({ ui: { language: "en" } }), "en");
  assert.equal(resolveVoiceLanguage({ ui: { language: "es" } }), "es");
  assert.equal(resolveVoiceLanguage({ ui: { language: "en" }, beats: { language: "es" } }), "en");
  assert.equal(resolveVoiceLanguage({}), "en");
});
