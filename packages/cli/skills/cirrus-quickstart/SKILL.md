---
name: cirrus-quickstart
description: Creates or adds Cirrus to an app. Use for new Cirrus projects, `cirrus init`,
    framework/provider wiring, the first `cirrus dev` run, env vars, or writing
    the first schema + query/mutation round-trip.
---

# Cirrus Quickstart

Set up a working Cirrus project as fast as possible.

## When to Use

- Starting a brand new project with Cirrus.
- Adding Cirrus to an existing Vite, Next.js, Astro, Nuxt, SvelteKit, or
  TanStack Start app.
- Scaffolding a Cirrus app for prototyping.

## When Not to Use

- The project already has Cirrus installed and `cirrus/` exists — just build,
  and run `cirrus codegen` after schema/function edits.
- You only need to add auth to an existing Cirrus app — use the
  `cirrus-setup-auth` skill.

## Workflow

1. Determine the starting point: new project or existing app.
2. New project: scaffold with `cirrus init` and pick a template.
3. Existing app: run `cirrus init --here` to patch the Vite config and wire
   Cirrus into the current project.
4. Run `cirrus codegen` to generate `cirrus/_generated/` and typecheck the
   schema + functions. This is the agent's feedback loop.
5. Start the dev loop with `cirrus dev` (ask the user to run it locally, or
   start it in the background for cloud/headless agents — it is long-running and
   does not exit).
6. Verify a query/mutation round-trip works end to end.

## Path 1: New Project (Recommended)

`cirrus init` fetches a whole-project template (frontend + worker entry + Vite
plugin + `cirrus/` already wired together).

```bash
cirrus init my-app --template vite
cd my-app
pnpm install
```

### Pick a template

| Template               | Stack                                          |
| ---------------------- | ---------------------------------------------- |
| `vite`                 | React + Vite (the simplest full-stack starter) |
| `standalone`           | Worker-only Cirrus backend, no frontend        |
| `astro`                | Astro integration                              |
| `nuxt`                 | Nuxt (Vue)                                     |
| `sveltekit`            | SvelteKit                                      |
| `tanstack-start-react` | TanStack Start (React)                         |
| `tanstack-start-solid` | TanStack Start (Solid)                         |

If the user has not specified a preference, default to `vite`. Pass `--template`
explicitly to avoid the interactive prompt. Templates are fetched remotely (via
`giget`) from `gh:anolilab/cirrus/templates/<type>`; pass `--from <dir>` to use a
local template directory offline.

### Generate types and push the first run

Run this yourself — it is one-shot and exits cleanly:

```bash
cirrus codegen
```

It writes `cirrus/_generated/` and typechecks your schema + functions. Read its
output to find out whether the code you just wrote is valid.

### Start the dev loop

```bash
cirrus dev
```

`cirrus dev` runs the Vite dev server with the Cloudflare Worker on the same
origin, plus codegen-on-save and the Cirrus Studio. It is long-running and does
not exit, so:

- **Local development (user at the keyboard):** ask the user to run `cirrus dev`
  in a terminal.
- **Cloud or headless agents:** start `cirrus dev` in the background.

Vite serves on `http://localhost:5173` by default; the Worker is served on the
same origin via `@cloudflare/vite-plugin`.

## Path 2: Add Cirrus to an Existing App

Use this when the user already has a Vite-based frontend and wants Cirrus as the
backend.

```bash
cirrus init --here
```

This finds the existing `vite.config.*` (or creates a minimal one), patches in
the Cirrus Vite plugin, and scaffolds a starter `cirrus/`. Then run
`cirrus codegen` and `cirrus dev` as above.

### Wire up the client provider

Create the `CirrusClient` once at module scope (never inside a component) and
wrap the app with the framework provider. React example:

```tsx
// src/client/main.tsx
import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// @cloudflare/vite-plugin serves the Worker on the same origin as Vite.
const url = (import.meta.env.VITE_CIRRUS_URL as string | undefined) ?? globalThis.location.origin;
const client = new CirrusClient({ url });

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <CirrusProvider client={client}>
            <App />
        </CirrusProvider>
    </StrictMode>,
);
```

Vue, Solid, and Svelte have matching providers in `@cirrus/vue`, `@cirrus/solid`,
and `@cirrus/svelte`. `VITE_CIRRUS_URL` is optional — it defaults to
`location.origin`, which is correct for the single-origin dev setup.

## Writing Your First Function

Create a schema and a query/mutation to verify the full loop.

`cirrus/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
```

`cirrus/todos.ts`:

```ts
import type { Id } from "@cirrus/server";
import { mutation, query, v } from "@cirrus/server";

export const list = query({
    args: {},
    handler: async (ctx) => ctx.db.query("todos").withIndex("by_creation").collect(),
});

export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, { text }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }),
});
```

Run `cirrus codegen`, then use it in a component. The `api` object and `Doc` /
`Id` types come from `cirrus/_generated/`:

```tsx
import { useMutation, useQuery } from "@cirrus/react";

import { api } from "../../cirrus/_generated/api";
import type { Doc } from "../../cirrus/_generated/dataModel";

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

Use `cirrus dev` during development. When ready to ship:

```bash
cirrus deploy
```

`cirrus deploy` runs codegen, the schema-drift gate, and `wrangler deploy`. Do
not use it during day-to-day development.

Before deploying, run the preflight:

```bash
cirrus doctor
```

It checks `wrangler.jsonc` (the `SHARD` durable-object binding), D1 placeholder
ids, `.dev.vars` secrets, and container exports.

## Next Steps

- Add authentication: use the `cirrus-setup-auth` skill.
- Add a prebuilt capability (mail, presence, storage, rate limit, crons):
  `cirrus registry add <item>`.
- Build your own reusable capability: use the `cirrus-create-package` skill.
- Plan a schema change: use the `cirrus-migration-helper` skill.
- Scaffold more functions: `vis generate cirrus-query --name=listMessages`,
  `cirrus-mutation`, `cirrus-action`, `cirrus-table`, `cirrus-cron` (always use
  the `--name=value` form).

## Checklist

- [ ] Determined starting point: new project or existing app.
- [ ] New project: scaffolded with `cirrus init --template <t>`.
- [ ] Existing app: ran `cirrus init --here` and wired `CirrusProvider`.
- [ ] Ran `cirrus codegen`: `cirrus/_generated/` exists and typecheck is clean.
- [ ] `cirrus dev` is running — user terminal, or background for cloud agents.
- [ ] Verified a query/mutation round-trip re-renders the client live.
