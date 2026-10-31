/** Pure helpers for slash commands, so they can be tested without Electron. */

export function parseCommand(raw) {
  const [command, ...rest] = String(raw ?? "").trim().split(/\s+/);
  return {
    command: (command ?? "").toLowerCase(),
    argument: rest.join(" ").trim(),
  };
}

/**
 * "on"/"off" (and common aliases) or toggle when the argument is empty.
 * Returns null for an unrecognised value so callers can show usage.
 */
export function parseToggle(argument, current) {
  const value = String(argument ?? "").trim().toLowerCase();
  if (!value) return !current;
  if (["on", "true", "1", "si", "sí", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  return null;
}

/**
 * Parse a fixed beat cadence: "30", "every 30", "cada 30", or "random".
 * Returns null for anything else so the command handler can show usage.
 */
export function parseBeatInterval(argument) {
  const value = String(argument ?? "").trim().toLowerCase();
  if (!value) return null;
  const match = value.match(
    /^(?:(?:every|cada|freq|frequency|intervalo)\s+)?(random|auto|aleatorio|\d{1,3})$/,
  );
  if (!match) return null;
  if (["random", "auto", "aleatorio", "0"].includes(match[1])) return { random: true };
  const minutes = Number(match[1]);
  if (minutes < 1 || minutes > 240) return null;
  return { minutes };
}

/**
 * Silent window: "23-8", "23:00-08:00" or "off"/"none".
 * Returns null for anything else.
 */
export function parseSilentHours(argument) {
  const value = String(argument ?? "").trim().toLowerCase();
  if (!value) return null;
  if (["off", "none", "no", "disable", "disabled"].includes(value)) {
    return { start: 0, end: 0 };
  }
  const match = value.match(/^(\d{1,2})(?::\d{2})?\s*[-–]\s*(\d{1,2})(?::\d{2})?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 0 || start > 23 || end < 0 || end > 23) return null;
  return { start, end };
}
