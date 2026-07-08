# ai

Workers AI for Lunora. Wraps [`@lunora/ai`](../../packages/ai) — which re-exports **Vercel AI SDK** helpers (`generateText`, `streamText`, `embed`, `tool`, …) over [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) — and wires it into your action context as `ctx.ai`. Scaffolds two example actions (`summarize` and `analyzeSentiment`) that you can use as-is or edit into your own AI-powered flows.

In `lunora dev` the `AI` binding is available without provisioning (Workers AI has a free tier), so you can iterate immediately.

## Install

```bash
lunora registry add ai
```

This:

1. Adds `@lunora/ai` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/ai/index.ts` (the `summarize` and `analyzeSentiment` actions) into your project — this is **yours** to edit.
3. Adds an `ai` binding entry to `wrangler.jsonc` for the **`AI`** binding (the Workers AI binding).

Then regenerate types:

```bash
lunora codegen
```

The functions surface in the generated `api` (client-reachable) as `ai/summarize` and `ai/analyzeSentiment` — i.e. `api.ai.summarize` and `api.ai.analyzeSentiment`.

## How it works

- **`ctx.ai`** is an instance of the Workers AI SDK (`@cloudflare/ai-sdk` provider), exposed on every `ActionCtx`. It exposes `.model(id)` to get a language model and `.embeddingModel(id)` to get an embedding model, both usable with any Vercel AI SDK helper.
- **`generateText`**, **`streamText`**, **`embed`**, **`tool`**, and every other Vercel AI SDK helper are re-exported from `@lunora/ai` — import them directly in your Lunora actions.
- The **`AI` binding** (Workers AI) is a single binding that gives you access to every model Workers AI supports. No per-model configuration needed.

### Choosing a model

The example uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, a fast, capable Llama model. Browse the [Workers AI catalog](https://developers.cloudflare.com/workers-ai/models/) for alternatives:

```ts
// Text generation
ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
ctx.ai.model("@cf/mistral/mistral-7b-instruct-v0.3");

// Embedding
ctx.ai.embeddingModel("@cf/baai/bge-base-en-v1.5");
```

### Using tools

`@lunora/ai` re-exports the `tool` helper from the Vercel AI SDK with `zod` integration:

```ts
import { generateText, tool } from "@lunora/ai";
import { z } from "zod";

const result = await generateText({
    model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    tools: {
        getWeather: tool({
            description: "Get the current weather",
            parameters: z.object({ city: z.string() }),
            execute: async ({ city }) => fetchWeather(city),
        }),
    },
    prompt: "What's the weather in Paris?",
});
```

### Streaming

Use `streamText` for streaming responses (e.g. to an SSE endpoint):

```ts
import { streamText } from "@lunora/ai";

const result = streamText({
    model: ctx.ai.model("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    prompt: "Write a short poem about TypeScript.",
});

// result.textStream is an AsyncIterable<string>
for await (const chunk of result.textStream) {
    // send chunk to client
}
```

## What you own

Everything under `lunora/ai/` is copied into your repo — change the model, add more actions, wire in tools, stream responses to your frontend, or switch to a different AI SDK provider however you like. `@lunora/ai` provides the Workers AI + Vercel AI SDK integration; this component is the idiomatic Lunora glue that turns it into `ctx.ai` and `api.ai.*`.
