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
