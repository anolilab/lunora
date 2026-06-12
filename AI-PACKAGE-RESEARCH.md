# `@cirrus/ai` — build-vs-reuse research (PLAN5 §6.2)

Decision record for the one unbuilt PLAN5 item: the Workers AI helper. The open question is
whether to **mirror void's thin `void/ai` binding wrapper**, or instead **reuse the Vercel AI SDK**
or **TanStack AI** as the foundation.

**Bottom line:** build the server-side `@cirrus/ai` on the **Vercel AI SDK core +
Cloudflare's `workers-ai-provider`**. Do _not_ hand-roll void's raw binding wrapper, and do _not_
use TanStack AI for the server layer. TanStack AI is relevant only for a separate, later
**client chat-UI** concern — and there it has one genuine advantage (a pluggable transport adapter)
that the AI SDK UI layer lacks.

_Companion docs: [`PLAN5.md`](./PLAN5.md) §6.2, [`VOID-TEARDOWN.md`](./VOID-TEARDOWN.md) §1.6/§6.
Research date: 2026-06-12._

---

## 1. The question is two layers, not one

PLAN5 §6.2 scopes `@cirrus/ai` as a **server** helper: `ai.run/stream` running _inside_ a Cirrus
query/mutation/action with `env.AI`. Void's `void/ai` is exactly that — a thin wrapper over the
Workers AI binding. But "ai-sdk vs tanstack ai" smuggles in a second, **client** concern
(`useChat`-style streaming UIs). They have different best answers, so keep them separate:

| Layer                     | What it is                                                           | Lives where                   | In §6.2 scope? | Best option                                    |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------- | -------------- | ---------------------------------------------- |
| **A — server inference**  | `run` / `stream` / `embed` / tools / structured output with `env.AI` | inside a Cirrus function      | **Yes**        | **Vercel AI SDK core + `workers-ai-provider`** |
| **B — client chat hooks** | `useChat`-style streaming chat UI across frameworks                  | browser, via a Cirrus adapter | No (defer)     | TanStack AI _iff_ it rides Cirrus's transport  |

---

## 2. Option A — Vercel AI SDK + `workers-ai-provider` (Cloudflare-official)

**What it is.** The Vercel AI SDK (`ai`) is the mature, provider-agnostic TS toolkit:
`generateText`, `streamText`, `generateObject`/`Output.object()`, `embed`, `tool()`, agent loops.
`workers-ai-provider` adapts the Cloudflare `env.AI` binding into an AI SDK provider. **Workers AI is
the zero-config default; any AI SDK provider is swappable** because every provider returns the same
`LanguageModel`/`EmbeddingModel` interface:

```ts
import { createWorkersAI } from "workers-ai-provider";
import { streamText, generateText } from "ai";

// default: zero-config, bound to the Workers AI binding
const workersai = createWorkersAI({ binding: env.AI });
const result = streamText({
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    messages,
});
return result.toTextStreamResponse(); // or .textStream for tokens inside a function

// bring-your-own: same call surface, different provider
import { openai } from "@ai-sdk/openai"; // or @ai-sdk/anthropic, @ai-sdk/google, …
const r2 = streamText({ model: openai("gpt-5"), messages });
```

**Pinned versions (latest, mutually compatible — verified 2026-06-12):**

| Package               | Version                | Notes                                                             |
| --------------------- | ---------------------- | ----------------------------------------------------------------- |
| `ai`                  | **^6.0.202**           | AI SDK v6 (core)                                                  |
| `workers-ai-provider` | **^3.1.14**            | Cloudflare-official; peers `ai ^6.0.0`, `@ai-sdk/provider ^3.0.0` |
| `@ai-sdk/openai`      | ^3.0.70                | optional / bring-your-own provider                                |
| `@ai-sdk/anthropic`   | ^3.0.83                | optional / bring-your-own provider                                |
| `@ai-sdk/react`       | ^3.0.204               | client only (Layer B) — not a `@cirrus/ai` dep                    |
| `zod`                 | `^3.25.76 \|\| ^4.1.8` | shared peer of `ai` + every `@ai-sdk/*` provider                  |

`@cirrus/ai` deps: `ai` + `workers-ai-provider` (the batteries-included default). External
`@ai-sdk/*` providers are **optional / bring-your-own** — declared as optional peers (or simply
documented), so the bundle stays Workers-AI-only unless the app opts into another provider.

**Research findings:**

- **Cloudflare-official.** The provider now lives in the [`cloudflare/ai`](https://github.com/cloudflare/ai)
  monorepo; the standalone `cloudflare/workers-ai-provider` repo was **archived 2025-03-18** (redirects
  to the monorepo). Cloudflare's own Workers AI docs document `createWorkersAI({ binding: env.AI })` +
  `generateText`/`streamText` as _the_ supported integration. Lowest runtime risk on Workers.
- **Provider-agnostic by design (the requirement).** Workers AI is the zero-config default, but the AI
  SDK's `LanguageModel` abstraction means any provider drops in unchanged — `@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/google`, OpenRouter, etc., optionally fronted by Cloudflare AI Gateway.
  `@cirrus/ai`'s helpers accept any AI SDK model, so apps are never locked to Workers AI.
- **Targets AI SDK v6** (`ai@^6.0.202`, `workers-ai-provider@^3.1.14`). Version matrix in §2.
- **Confirmed supported via the provider:** `generateText`, `streamText`, structured output
  (`generateObject` / `Output.object()` with Zod). `safePrompt` option for Workers AI safety injection.
- **Provider-agnostic by construction.** Same call surface whether the model is Workers AI _or_ an
  external provider (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …). Void's "18 providers" parity is free,
  plus AI Gateway can be layered in.
- **RAG synergy with [`@cirrus/vectors`](./packages/vectors/):** `embed()` → `vectors.upsert/query`
  against Vectorize. This is a Cirrus differentiator void lacks (void has inference, no Vectorize).

**Gaps to verify (not blockers):** the provider's docs are thin on **tool calling**, **embeddings**
(`textEmbeddingModel`), **image models**, and **AI Gateway** specifics. AI SDK _core_ supports
`tool()`/`embed()` generally, and Workers AI exposes `@cf/baai/bge-*` embedding + image models — but
whether they're reachable through the _provider_ vs. a direct `env.AI.run(...)` fallback must be
confirmed (see §6). Pragmatic stance: expose AI SDK primitives for text/tools/structured-output, and
keep a thin `ctx.ai.run(model, input)` passthrough to the raw binding for embeddings/images until the
provider path is verified.

---

## 3. Option B — TanStack AI (`@tanstack/ai`)

**What it is.** A type-safe, provider-agnostic AI SDK whose center of gravity is the **chat/client**
experience: streaming chat, isomorphic tool calling, agent loops, framework `useChat` hooks.

**Research findings:**

- **Active but pre-1.0.** Currently `v0.28.0`, shipping frequently — API still churning. Not a stable
  foundation to expose through a published `@cirrus/*` package surface yet.
- **No Cloudflare Workers AI adapter.** Provider adapters are `@tanstack/ai-{openai,anthropic,gemini,
openrouter,ollama,groq,grok,fal}`. There is **no** `env.AI` adapter — so for Layer A it can't even
  talk to the Workers AI binding without us writing the adapter ourselves. Disqualifying for the
  server layer.
- **Client connection adapters: `SSE`, `HTTP stream`, _and `custom`_.** This is the one genuine point
  in its favor for **Layer B**: the `custom` connection adapter is an explicit seam to bridge chat
  streaming onto **Cirrus's own WS/subscription transport**, instead of forcing a second HTTP/SSE
  stream alongside Cirrus reactivity. The Vercel AI SDK UI layer (`@ai-sdk/react` `useChat`) assumes
  its own data-stream protocol and is harder to retarget.
- **Framework bindings:** React + Solid `useChat` are first-class in the docs; Vue/Svelte are stated
  as supported (GitHub blurb) but less evidenced in docs. This _almost_ matches Cirrus's own
  react/solid/svelte/vue adapter set — relevant only if/when Layer B is built.
- **Ecosystem affinity:** Cirrus already depends on TanStack DB ([`@cirrus/db`](./packages/db/)), so a
  TanStack-family client SDK is culturally consistent.

---

## 4. Why not mirror void's thin wrapper

Void's `void/ai` (`ai.run/stream/models/toMarkdown/image/provider`, 18 providers, metered) is a raw
wrapper over `env.AI`. Copying it means **re-implementing tool-calling, structured-output, and stream
plumbing by hand** and **locking to Workers AI only**. Wrapping the AI SDK is _less_ code and far more
capable: provider-agnosticism, tools, structured output, and a standard streaming protocol come for
free. The only thing worth keeping from void's shape is the ergonomic `ctx.ai.run(model, input)`
passthrough as an escape hatch.

---

## 5. The transport tension (the real design subtlety)

Cirrus's value prop is reactivity over its **own** WS/delta transport. Both client SDKs default to
their own streaming channel:

- **`@ai-sdk/react` `useChat`** → AI SDK data-stream protocol (HTTP/SSE). Fixed; competes with Cirrus
  subscriptions.
- **TanStack AI client** → `SSE | HTTP stream | custom`. The `custom` adapter is a clean bridge onto a
  Cirrus subscription.

The Cirrus-native ideal for chat is: **stream AI tokens server-side through a Cirrus action/subscription
and render with the existing framework adapters** — possibly needing _no_ third-party client SDK at all.
If a client SDK _is_ wanted later, TanStack AI's `custom` adapter is the better fit precisely because of
this seam. This nuance is why Layer B is deferred, not decided now.

---

## 6. Recommendation

1. **Build `@cirrus/ai` (§6.2) on Vercel AI SDK core + `workers-ai-provider`.** Server-only. Wire
   `env.AI → createWorkersAI`, hang an `ai` helper off the function ctx, re-export `streamText` /
   `generateText` / `generateObject` / `embed` / `tool`, keep a `ctx.ai.run(model, input)` raw
   passthrough escape hatch. Add `AI` binding inference + wrangler reconcile in
   [`@cirrus/config`](./packages/config/) (`infer-bindings.ts`) — unchanged regardless of SDK.
2. **Pair with `@cirrus/vectors` for RAG** (`embed` → Vectorize) — the documented differentiator.
3. **Do not** fold a client chat SDK into `@cirrus/ai`; keep §6.2 server-scoped. Ship ESM-only
   (see [[esm-only-packages]]).
4. **Defer Layer B** (client chat hooks) to its own plan item. If pursued: prefer streaming over
   Cirrus's native transport; if a client SDK is used, **TanStack AI via its `custom` connection
   adapter** (framework parity + transport bridge) over `@ai-sdk/react`.

### Proposed PLAN5 §6.2 rewrite (drop-in)

> **6.2 — `@cirrus/ai` (Workers AI helper) `[P]`**
>
> - **Does:** additive server package over the `AI` binding built on the **Vercel AI SDK core +
>   `workers-ai-provider`** (Cloudflare-official). Exposes `ctx.ai` in functions, re-exports
>   `streamText`/`generateText`/`generateObject`/`embed`/`tool`, keeps a raw `ctx.ai.run(model,input)`
>   escape hatch, and pairs `embed` with `@cirrus/vectors` for RAG. NOT void's hand-rolled wrapper;
>   NOT TanStack AI (no Workers AI adapter, pre-1.0).
> - **Files:** new `packages/ai/`; `packages/config/src/infer-bindings.ts` (add `AI`).
> - **Done-when:** `ctx.ai`/`streamText` works inside a function against `env.AI`; `embed`→`@cirrus/vectors`
>   round-trips; the `AI` binding is auto-reconciled into `wrangler.jsonc`.
> - **Deferred (Layer B, separate item):** client chat hooks — stream tokens over Cirrus's transport;
>   if a client SDK is used, TanStack AI via its `custom` connection adapter.

### Open verification items before/while implementing

- [x] **Pin versions — resolved (2026-06-12):** `ai@^6.0.202` + `workers-ai-provider@^3.1.14`
      (peers `ai ^6.0.0`, `@ai-sdk/provider ^3.0.0`); optional providers `@ai-sdk/openai@^3.0.70`,
      `@ai-sdk/anthropic@^3.0.83`; shared `zod ^3.25.76 || ^4.1.8`.
- [ ] Confirm whether `workers-ai-provider` exposes `textEmbeddingModel` (e.g. `@cf/baai/bge-*`) and
      image models through the AI SDK, or whether those need the raw `env.AI.run(...)` passthrough.
- [ ] Confirm tool-calling works through the provider for at least one Workers AI model.
- [ ] Confirm AI SDK core bundle size + Workers runtime compatibility on the current toolchain
      (Cloudflare documents it as working; verify under Cirrus's packem/Vite build).
- [ ] Decide the `ctx.ai` shape (provider instance vs. pre-bound helpers) consistent with how
      `@cirrus/vectors`/`@cirrus/storage` hang off ctx.

---

## 7. Sources

- [Vercel AI SDK · Cloudflare Workers AI docs](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/)
- [cloudflare/ai monorepo](https://github.com/cloudflare/ai) · [archived workers-ai-provider repo](https://github.com/cloudflare/workers-ai-provider)
- [AI SDK community provider: Cloudflare Workers AI](https://ai-sdk.dev/providers/community-providers/cloudflare-workers-ai)
- [TanStack/ai (GitHub)](https://github.com/TanStack/ai) · [TanStack AI docs](https://tanstack.com/ai/latest/docs) · [@tanstack/ai on npm](https://www.npmjs.com/package/@tanstack/ai)
- Internal: [`VOID-TEARDOWN.md`](./VOID-TEARDOWN.md) §1.6 (`void/ai`), §6 (gap analysis); [`PLAN5.md`](./PLAN5.md) §6.2.
