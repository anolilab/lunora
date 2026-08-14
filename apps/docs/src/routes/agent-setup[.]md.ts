import { createFileRoute } from "@tanstack/react-router";

import { siteConfig } from "~/site.config";

/**
 * The one URL a user pastes at their coding agent to make it useful on Lunora.
 *
 * It is deliberately a single flat file rather than a docs page: an agent given
 * a URL fetches it once and keeps the result in context, so everything it needs
 * to not guess — the layout, the four building blocks, the codegen contract,
 * and the mistakes it would otherwise make — has to be in this one response.
 *
 * Served as Markdown so a human can read what they are about to paste. Keep it
 * short: this competes for the agent's context with the user's actual task, and
 * the deep material is behind the MCP endpoint and `llms-full.txt`, which it is
 * told about below.
 */

const { url } = siteConfig.brand;

const AGENT_SETUP = `# Lunora — agent setup

You are working in a project that uses **Lunora**: a type-safe, real-time
backend that runs on Cloudflare Workers and Durable Objects, with a Vite-first
dev loop. Read this before writing Lunora code.

## Get the full docs

Prefer these over crawling the site page by page:

- **MCP (best):** ${url}/mcp — an unauthenticated Streamable HTTP endpoint
  exposing \`lunora_search_docs\`, \`lunora_get_doc\`, \`lunora_list_docs\`.
  Search returns the relevant sections directly.

      claude mcp add --transport http lunora-docs ${url}/mcp

- **Whole docs as text:** ${url}/llms-full.txt
- **Index only:** ${url}/llms.txt

## Start a project

    npx lunorash@alpha init my-app
    cd my-app
    npx lunora dev

\`lunora dev\` runs the frontend, the backend, and the Studio admin UI on one
Vite server, and regenerates types on every save.

## The shape of a Lunora app

Backend code lives in \`lunora/\`. The generated client contract lives in
\`lunora/_generated/\` — **never edit those files by hand**, they are rewritten
on every codegen run.

\`\`\`
lunora/
  schema.ts          defineSchema / defineTable
  <name>.ts          query / mutation / action
  _generated/        api.ts, server.ts, dataModel.ts  (generated)
\`\`\`

## The four building blocks

\`\`\`ts
// lunora/schema.ts
import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
        createdAt: v.number(),
    }).index("by_creation", ["createdAt"]),
});
\`\`\`

\`\`\`ts
// lunora/todos.ts
import { mutation, query, v } from "./_generated/server.js";

// No arguments: call .query() straight off the builder.
export const list = query.query(async ({ ctx }) => await ctx.db.query("todos").withIndex("by_creation").collect());

// With arguments: declare them with .input(), then .mutation().
// Args arrive destructured on the single object the handler receives.
export const add = mutation
    .input({ text: v.string() })
    .mutation(async ({ args: { text }, ctx }) => ctx.db.insert("todos", { createdAt: Date.now(), done: false, text }));
\`\`\`

**These are chainable builders, not option objects.** \`query({ args, handler })\`
is not the API and will not compile — it is \`query.query(handler)\` and
\`mutation.input({...}).mutation(handler)\`. The handler takes one object
(\`{ args, ctx }\`), not positional parameters.

\`ctx.db\` gives \`.query(table)\` (with \`.withIndex(name)\` / \`.collect()\`),
\`.insert\`, \`.patch\`, \`.delete\`.

- **query** — reads. Every query is a live subscription; clients re-render when
  the data changes. Cannot write.
- **mutation** — transactional writes. Pushes updates to every subscribed
  client. No network calls.
- **action** — the escape hatch for anything non-transactional: \`fetch\`,
  third-party SDKs, AI calls. Cannot touch \`ctx.db\` directly; it calls queries
  and mutations.
- **httpRouter** — raw HTTP endpoints, for webhooks.

## On the client

\`\`\`tsx
import { useMutation, useQuery } from "@lunora/react";

import { api } from "../../lunora/_generated/api.js";
import type { Doc } from "../../lunora/_generated/dataModel.js";

// useQuery takes the args object as its second parameter, and returns
// \`undefined\` until the first result arrives.
const todos = useQuery(api.todos.list, {}) as Doc<"todos">[] | undefined;

// useMutation returns an object, not a bare function.
const { mutate: add, pending } = useMutation(api.todos.add);
\`\`\`

Adapters exist for React, Vue, Svelte, Solid, and Angular; \`@lunora/client\` is
the framework-free client.

**Note the \`.js\` extensions on \`_generated/\` imports.** That directory is
consumed under NodeNext where the extension is required. Everywhere else in a
Lunora project, relative imports are written without an extension.

## Rules that save you a debugging session

1. **The builders chain.** \`query.query(fn)\` and
   \`mutation.input({...}).mutation(fn)\`. Passing an options object is the most
   common mistake here and it does not compile.
2. **Import from \`_generated/api\`, never by string path.** That is what makes
   the client type-safe end to end; a renamed field stops compiling instead of
   failing at runtime.
3. **Never edit \`_generated/\`.** Change \`schema.ts\` and let codegen run. If
   types look stale, run \`npx lunora codegen\`.
4. **Index before you query by a field.** Declare it with
   \`.index("by_x", ["x"])\` on the table and read it with \`.withIndex("by_x")\`.
5. **No \`fetch\` in a query or mutation.** They are transactional and get
   retried. Anything with a side effect belongs in an action.
6. **One Durable Object by default.** Only reach for \`.shardBy(key)\` when
   there is real per-user/tenant/room contention, and \`.global()\` when reads
   need to be replicated across regions. Neither is required to ship.
7. **Validate args with \`v.*\`.** The validators are the runtime boundary as
   well as the source of the inferred types.

## Commands

    npx lunora dev            frontend + backend + Studio, with codegen on save
    npx lunora codegen        regenerate _generated/ once
    npx lunora deploy         deploy to your own Cloudflare account
    npx lunora migrate        apply schema migrations
    npx lunora seed           deterministic seed data
    npx lunora doctor         diagnose a broken project

## If you are unsure

Search the MCP endpoint above rather than guessing at an API. Lunora is
pre-1.0 and the surface moves; a wrong-but-plausible API is the most common
failure mode here.
`;

export const Route = createFileRoute("/agent-setup.md")({
    server: {
        handlers: {
            GET() {
                return new Response(AGENT_SETUP, {
                    headers: {
                        // Inline, not a download: the point is that a human can
                        // read what they are about to hand their agent.
                        "cache-control": "public, max-age=3600",
                        "content-type": "text/markdown; charset=utf-8",
                    },
                });
            },
        },
    },
});
