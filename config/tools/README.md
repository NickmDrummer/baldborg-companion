# User tools

Drop `.mjs` files in this directory and restart Baldborg. Each file must
default-export an object:

```js
export default {
  name: "disk_free",
  description: "Free disk space. Use it when the client asks about storage.",
  parameters: { type: "object", properties: {}, required: [] },
  async run(args) {
    return { ok: true, summary: "..." };
  },
};
```

Optional confirmation for actions with side effects:

```js
export default {
  name: "backup_now",
  description: "Start a backup job.",
  parameters: { type: "object", properties: {}, required: [] },
  prepare() {
    return {
      requiresConfirmation: true,
      summary: "¿Inicio una copia de seguridad ahora?",
      async run() {
        return { ok: true, summary: "Copia iniciada." };
      },
    };
  },
};
```

Rules:

- `name` must be unique and must not collide with a built-in tool.
- `run` must return a JSON-serialisable object; include `summary` with the
  human-readable result, and `ok: false` on failure.
- Tools run with your user's privileges and no sandbox. Only install tools you
  trust.
- If a tool fails to load, Baldborg logs it and continues without it.

Built-ins: `get_weather`, `set_reminder`, `get_time`, `system_status`,
`team_fixtures`.
