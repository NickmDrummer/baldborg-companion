/**
 * One-time migration from the old "delamain" configuration directory.
 *
 * Imported first by main.js so it runs before the brain and tools modules read
 * their state files.
 */

import { existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NEW_DIR = join(homedir(), ".config", "baldborg");
const OLD_DIR = join(homedir(), ".config", "delamain");
const FILES = ["memory.json", "reminders.json", "state.json"];

if (!existsSync(NEW_DIR) && existsSync(OLD_DIR)) {
  try {
    renameSync(OLD_DIR, NEW_DIR);
    console.info("[baldborg] migrated ~/.config/delamain to ~/.config/baldborg");
  } catch (error) {
    console.warn("[baldborg] could not move the old config dir:", error.message);
    mkdirSync(NEW_DIR, { recursive: true });
    for (const file of FILES) {
      try {
        copyFileSync(join(OLD_DIR, file), join(NEW_DIR, file));
      } catch {
        /* file may not exist */
      }
    }
  }
}
