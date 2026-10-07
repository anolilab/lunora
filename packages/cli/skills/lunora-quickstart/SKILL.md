---
name: lunora-quickstart
description: Creates a new Lunora project or adds Lunora to an existing app, then gets
    the first schema + query/mutation round-trip running. Use when the user asks
    to "start a Lunora app", "add Lunora to my Vite/Next/Nuxt/SvelteKit/Astro
    app", runs `lunora init` (`--vite`, `-t`, `--here`, `--add`), needs the
    client provider wired (`LunoraClient` + `LunoraProvider`), or is running
    `lunora dev` for the first time (background mode, `lunora dev status`/`logs`/
    `stop`, `VITE_LUNORA_URL`).
---

# Lunora Quickstart

Get a working Lunora project with one live query/mutation round-trip.

Skip this skill when `lunora/` already exists (just build, and run
`lunora codegen` after edits) or when the task is only auth
(`lunora-setup-auth`).

## Workflow

1. New project: `lunora init <name> --vite <framework>` or `-t <template>`.
   Existing app: `lunora init --here`.
2. `lunora codegen` to generate `lunora/_generated/`.
3. Start the dev server in the background (`lunora dev --background`).
4. Write or adapt a query + mutation and use them from a component.
5. `lunora verify` (wrangler config + codegen dry-run + `tsc --noEmit`) passes,
   and the client re-renders live after a mutation.

## Path 1: new project

```bash
lunora init my-app --vite react
cd my-app
pnpm install
```

Two scaffold paths take different flags.

`--vite <framework>` applies the Lunora layer over the official create-vite
base. Use it for a plain SPA: `react` (the default), `vue`, `solid`, `svelte`,
or `vanilla` (overlay-only, not in the picker). `-t react|vue|solid|svelte` is
accepted as an alias for the same overlay.

`-t` / `--template <type>` fetches a whole-project template from
`gh:anolilab/lunora/templates/<type>`:

| `-t` value                    | Stack                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| `next`                        | Next.js App Router (OpenNext) + a standalone Lunora worker       |
| `vinext`                      | Next.js App Router on Vite (vinext), one worker (experimental)   |
| `vinext-pages`                | Next.js Pages Router on Vite (vinext), one worker (experimental) |
| `tanstack-start-react`        | TanStack Start (React), SSR with live-loader routes              |
| `tanstack-start-solid`        | TanStack Start (Solid)                                           |
| `tanstack-start-react-rspack` | TanStack Start (React) on Rsbuild, one worker                    |
| `rspack-react`                | React SPA on Rsbuild (`@lunora/rspack`)                          |
| `solid-v2`                    | Solid 2.0 SPA (`@solidjs/web`, `vite-plugin-solid` 3)            |
| `react-router`                | React Router v7 framework mode, SSR in the Lunora worker         |
| `astro`                       | Astro, Lunora composed into the adapter worker                   |
| `sveltekit`                   | SvelteKit, Lunora composed into the adapter worker               |
| `nuxt`                        | Nuxt (Vue), Lunora mounted in Nitro                              |
| `analog`                      | AnalogJS (Angular), Lunora mounted in Nitro                      |
| `expo`                        | React Native (Expo) app + a Lunora worker                        |
| `standalone`                  | Worker-only backend, no frontend                                 |

There is no `vite` template value; `-t vite` errors. Solid 2.0 is a template
rather than an overlay because create-vite's Solid base is still 1.x, so
`--vite solid` stays on Solid 1.x.

In a non-interactive shell, `init` errors unless it gets a name and a framework
(or `--yes`, which takes the React overlay). As an agent, pass `--vite` or `-t`
explicitly; if the user stated no preference, use `--vite react`.

Other flags:

```bash
lunora init my-app --vite react --ci github     # add a deploy pipeline (or --ci gitlab)
lunora init my-app -t next --add auth,email     # add capabilities without prompting
lunora init my-app --vite react --yes           # skip the interactive auth/email offer
lunora init my-app --vite react --dry-run       # walk every step, write nothing
```

`--add` takes a comma-separated list of `ai | auth | auth-ui | backup | browser
| cloudflare-access | crons | email | flags | hyperdrive | payment | presence |
queue | storage | workflow`. `--ref <branch|tag|commit>` pins the template
source (e.g. `--ref alpha`); `--from <dir>` copies from a local templates root.

## Path 2: add Lunora to an existing app

```bash
lunora init --here
```

This detects the framework from `package.json`, scaffolds `lunora/schema.ts` and
`lunora/messages.ts` (skipped if a schema exists), and patches or creates the
Vite config with the `lunora()` plugin. SvelteKit, Nuxt and Astro wire Lunora
through their server entry instead, so their Vite config is left alone. It then
prints framework-specific next steps: the packages to install, the provider to
mount, and how to compose the worker. Follow those; the CLI does not edit
framework-owned files.

Templates and `--vite` overlays map `#lunora/*` to `./lunora/*` in
`package.json` `imports`, which is why their function files import
`#lunora/_generated/server.js`. A `--here` project has no such mapping; its
starter uses the relative `./_generated/server`. Match whichever the project
already uses.

### Client provider

Create the `LunoraClient` once at module scope (not inside a component, or every
render opens a new socket) and wrap the app in the framework provider:

```tsx
// src/client/main.tsx
import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
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

`LunoraClient` is also exported by `@lunora/client`. Other adapters:
`@lunora/vue`, `@lunora/solid`, `@lunora/svelte`, `@lunora/angular`
(`provideLunora` / `injectLunoraClient`), and `@lunora/react-native`
(`createLunoraClient`, re-exporting `@lunora/react`). `@lunora/astro` and
`@lunora/nuxt` mount Lunora server-side. `VITE_LUNORA_URL` is optional; the
same-origin default is right for local dev.

## First function

`lunora/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "lunorash/server";

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
import { mutation, query, v } from "#lunora/_generated/server.js";

export const list = query.query(async ({ ctx }) => ctx.db.query("todos").withIndex("by_creation").collect());

export const add = mutation
    .input({ text: v.string().max(4096) })
    .mutation(async ({ ctx, args }) => ctx.db.insert("todos", { text: args.text, done: false, createdAt: Date.now() }));
```

Run `lunora codegen`, then call it from a component. Argument and return types
are inferred from the generated `api`, so no casts are needed:

```tsx
import { useMutation, useQuery } from "@lunora/react";

import { api } from "../../lunora/_generated/api";

export const Todos = () => {
    const todos = useQuery(api.todos.list, {});
    const { mutate: add, pending } = useMutation(api.todos.add);

    return (
        <div>
            <button disabled={pending} onClick={() => add({ text: "New todo" })}>
                Add
            </button>
            {todos?.map((todo) => (
                <div key={todo._id}>{todo.text}</div>
            ))}
        </div>
    );
};
```

`useQuery` returns `undefined` while loading, then re-renders whenever a
mutation changes the queried rows. A function in a folder nests in `api`:
`lunora/billing/invoices.ts` is `api.billing.invoices.*`.

## Dev server

`lunora dev` runs the worker (behind Vite via `@cloudflare/vite-plugin` in Vite
projects), codegen-on-save, and the embedded Studio at `/__lunora`. It does not
exit on its own.

- User at the keyboard: ask them to run `lunora dev` in a terminal.
- Agent: run `lunora dev --background`. It detaches, waits until the server
  answers, prints `Dev server running at <url> (pid <n>)`, and exits. When an AI
  agent is detected (Claude Code, Cursor, Codex, …), plain `lunora dev` does
  this automatically with JSON logs; `LUNORA_AGENT_MODE=0` opts out. Avoid a
  bare foreground `lunora dev` in your own shell, since it blocks until killed.

```bash
lunora dev status --json   # url, pid, uptime, logFile
lunora dev logs --lines 50 # tail .lunora/dev.log
lunora dev stop            # idempotent
```

A second `lunora dev` reports the running instance instead of starting another
(`.lunora/dev.json` is the lockfile). `GET /_lunora/status` returns
`{"ok":true}` once the worker is up. Vite defaults to `http://localhost:5173`.
`lunora dev --tunnel` shares the worker on a public `*.trycloudflare.com` URL
(needs `cloudflared`).

## Shipping

```bash
lunora doctor   # preflight: SHARD DO binding, placeholder D1 ids, .dev.vars secrets, container exports
lunora deploy   # codegen + schema-drift gate + wrangler deploy
```

Use `lunora-deploy` for bindings, secrets and environments.

## Next steps

- Auth: `lunora-setup-auth`.
- Add-ons: `lunora add <feature>` (e.g. `email`, `storage`, `crons`,
  `presence`; `lunora registry list` for all). Mail, storage and scheduling have
  their own skills: `lunora-setup-mail`, `lunora-setup-storage`,
  `lunora-setup-scheduler`.
- Schema and function rules: `lunora-functions`. Schema changes on live data:
  `lunora-migration-helper`.
