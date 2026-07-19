---
name: lunora-quickstart
description: Creates or adds Lunora to an app. Use for new Lunora projects, `lunora init`,
    framework/provider wiring, the first `lunora dev` run, env vars, or writing
    the first schema + query/mutation round-trip.
---

# Lunora Quickstart

Set up a working Lunora project as fast as possible.

## When to Use

- Starting a brand new project with Lunora.
- Adding Lunora to an existing Vite, Next.js, Astro, Nuxt, SvelteKit, or
  TanStack Start app.
- Scaffolding a Lunora app for prototyping.

## When Not to Use

- The project already has Lunora installed and `lunora/` exists — just build,
  and run `lunora codegen` after schema/function edits.
- You only need to add auth to an existing Lunora app — use the
  `lunora-setup-auth` skill.

## Workflow

1. Determine the starting point: new project or existing app.
2. New project: scaffold with `lunora init` and pick a template.
3. Existing app: run `lunora init --here` to patch the Vite config and wire
   Lunora into the current project.
4. Run `lunora codegen` to generate `lunora/_generated/` and typecheck the
   schema + functions. This is the agent's feedback loop.
5. Start the dev loop. As an agent, run `lunora dev --background` — it starts
   the server as a managed detached process, blocks until it accepts requests,
   prints the URL + PID, and returns (under a detected AI agent, plain
   `lunora dev` does this automatically, with JSON logs). Never leave a bare
   `lunora dev` running in your own shell — it is long-running and does not
   exit.
6. Verify a query/mutation round-trip works end to end.

## Path 1: New Project (Recommended)

`lunora init` fetches a whole-project template (frontend + worker entry + Vite
plugin + `lunora/` already wired together).

```bash
lunora init my-app --template vite
cd my-app
pnpm install
```

### Pick a template

| Template               | Stack                                          |
| ---------------------- | ---------------------------------------------- |
| `vite`                 | React + Vite (the simplest full-stack starter) |
| `standalone`           | Worker-only Lunora backend, no frontend        |
| `astro`                | Astro integration                              |
| `next`                 | Next.js (App Router, OpenNext on Cloudflare)   |
| `nuxt`                 | Nuxt (Vue)                                     |
| `sveltekit`            | SvelteKit                                      |
| `tanstack-start-react` | TanStack Start (React)                         |
| `tanstack-start-solid` | TanStack Start (Solid)                         |

If the user has not specified a preference, default to `vite`. Pass `--template`
explicitly to avoid the interactive prompt. Templates are fetched remotely (via
`giget`) from `gh:anolilab/lunora/templates/<type>`; pass `--from <dir>` to use a
local template directory offline.

### Generate types and push the first run

Run this yourself — it is one-shot and exits cleanly:

```bash
lunora codegen
```

It writes `lunora/_generated/` and typechecks your schema + functions. Read its
output to find out whether the code you just wrote is valid.

### Start the dev loop

```bash
lunora dev
```

`lunora dev` runs the Vite dev server with the Cloudflare Worker on the same
origin, plus codegen-on-save and the Lunora Studio. It is long-running and does
not exit, so:

- **Local development (user at the keyboard):** ask the user to run `lunora dev`
  in a terminal.
- **Agents:** run `lunora dev --background`. It detaches the server, waits until
  it answers HTTP, prints `Dev server running at <url> (pid <n>)`, and exits —
  no orphaned shell, no PID bookkeeping. When Lunora detects an AI agent
  (Claude Code, Cursor, Codex, …), plain `lunora dev` flips into this mode
  automatically with JSON logs; `LUNORA_AGENT_MODE=0` opts out.

Manage the running server afterwards:

```bash
lunora dev status --json   # machine-readable: url, pid, uptime, logFile
lunora dev logs --lines 50 # tail the captured output (.lunora/dev.log)
lunora dev stop            # idempotent — succeeds even if nothing runs
```

A second `lunora dev` never double-starts: it reports the existing instance
(`.lunora/dev.json` is the lockfile). Probe readiness or liveness at
`GET /_lunora/status` (`{"ok":true}`).

Vite serves on `http://localhost:5173` by default; the Worker is served on the
same origin via `@cloudflare/vite-plugin`.

## Path 2: Add Lunora to an Existing App

Use this when the user already has a Vite-based frontend and wants Lunora as the
backend.

```bash
lunora init --here
```

This finds the existing `vite.config.*` (or creates a minimal one), patches in
the Lunora Vite plugin, and scaffolds a starter `lunora/`. Then run
`lunora codegen` and `lunora dev` as above.

### Wire up the client provider

Create the `LunoraClient` once at module scope (never inside a component) and
wrap the app with the framework provider. React example:

```tsx
// src/client/main.tsx
import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// @cloudflare/vite-plugin serves the Worker on the same origin as Vite.
const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <LunoraProvider client={client}>
            <App />
        </LunoraProvider>
    </StrictMode>,
);
```

Vue, Solid, and Svelte have matching providers in `@lunora/vue`, `@lunora/solid`,
and `@lunora/svelte`. `VITE_LUNORA_URL` is optional — it defaults to
`location.origin`, which is correct for the single-origin dev setup.

## Writing Your First Function

Create a schema and a query/mutation to verify the full loop.

`lunora/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
```

`lunora/todos.ts`:

```ts
import type { Id } from "@lunora/server";
import { mutation, query, v } from "@lunora/server";

export const list = query.query(async ({ ctx }) => ctx.db.query("todos").withIndex("by_creation").collect());

export const add = mutation
    .input({ text: v.string() })
    .mutation(async ({ ctx, args: { text } }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }));
```

Run `lunora codegen`, then use it in a component. The `api` object and `Doc` /
`Id` types come from `lunora/_generated/`:

```tsx
import { useMutation, useQuery } from "@lunora/react";

import { api } from "../../lunora/_generated/api";
import type { Doc } from "../../lunora/_generated/dataModel";

function Todos() {
    const todos = useQuery(api.todos.list, {}) as Doc<"todos">[] | undefined;
    const { mutate: add, pending } = useMutation(api.todos.add);

    return (
        <div>
            <button disabled={pending} onClick={() => add({ text: "New todo" })}>
                Add
            </button>
            {todos?.map((t) => (
                <div key={t._id}>{t.text}</div>
            ))}
        </div>
    );
}
```

`useQuery` opens a live subscription: the list re-renders the instant any
mutation changes the queried rows.

## Development vs Production

Use `lunora dev` during development. When ready to ship:

```bash
lunora deploy
```

`lunora deploy` runs codegen, the schema-drift gate, and `wrangler deploy`. Do
not use it during day-to-day development.

Before deploying, run the preflight:

```bash
lunora doctor
```

It checks `wrangler.jsonc` (the `SHARD` durable-object binding), D1 placeholder
ids, `.dev.vars` secrets, and container exports.

## Next Steps

- Add authentication: use the `lunora-setup-auth` skill.
- Add a prebuilt capability (mail, presence, storage, rate limit, crons):
  `lunora registry add <item>` (see `lunora registry list`). For capabilities
  with a dedicated skill, use it: `lunora-setup-mail`, `lunora-setup-storage`,
  `lunora-setup-scheduler`. See the `lunora` router's capability entry for the
  full routing.
- Build your own reusable capability: use the `lunora-create-package` skill.
- Plan a schema change: use the `lunora-migration-helper` skill.
- Scaffold more functions: `vis generate lunora-query --name=listMessages`,
  `lunora-mutation`, `lunora-action`, `lunora-table`, `lunora-cron` (always use
  the `--name=value` form).

## Checklist

- [ ] Determined starting point: new project or existing app.
- [ ] New project: scaffolded with `lunora init --template <t>`.
- [ ] Existing app: ran `lunora init --here` and wired `LunoraProvider`.
- [ ] Ran `lunora codegen`: `lunora/_generated/` exists and typecheck is clean.
- [ ] Dev server is running — user terminal, or `lunora dev --background`
      (check with `lunora dev status`).
- [ ] Verified a query/mutation round-trip re-renders the client live.
