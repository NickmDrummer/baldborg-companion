import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Example user tool. Copy it, rename it and change the body to add your own.
 * Contract:
 *   name        unique tool id (must not collide with a built-in)
 *   description what the model reads to decide when to call it; be explicit
 *   parameters  JSON schema for the arguments
 *   run(args)   returns a JSON-serialisable result ({ ok: true, ... })
 *   prepare?(args) optional; return { requiresConfirmation, summary, run }
 *               to ask the operator before executing side effects
 */
export default {
  name: "disk_free",
  description:
    "Free disk space for the root and home filesystems. Use it when the client asks about storage or a full disk.",
  parameters: { type: "object", properties: {}, required: [] },
  async run() {
    const { stdout } = await run("df", ["-h", "/", process.env.HOME ?? "/"]);
    return { ok: true, summary: stdout.trim() };
  },
};
