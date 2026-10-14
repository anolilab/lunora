# @lunora/agent

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

Durable AI agents for [Lunora](https://lunora.sh): `defineAgent` compiles a replay-safe tool-loop onto Cloudflare Workflows — each LLM turn and each tool call is a named durable step, thread messages persist idempotently in DO SQLite, and clients watch the conversation live over Lunora's reactive subscriptions.

```ts
// lunora/agents.ts
import { defineAgent, defineAgentTool } from "@lunora/agent";
import { jsonSchema } from "@lunora/ai";

export const support = defineAgent({
    instructions: "You are a helpful support agent.",
    memory: { source: "rag:searchDocs" }, // an action over @lunora/ai/rag's retrieve
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tools: {
        getWeather: defineAgentTool({
            description: "Look up the current weather for a city.",
            execute: async ({ city }, { idempotencyKey, run }) => run({ __lunoraRef: "weather:lookup" }, { city, key: idempotencyKey }),
            inputSchema: jsonSchema({ properties: { city: { type: "string" } }, required: ["city"], type: "object" }),
        }),
    },
});
```

Codegen auto-registers the agent runtime functions (`agents:agentMessages`, …) and the
`ctx.agents.support` producer as soon as an agent is declared — no re-export boilerplate.

```ts
// lunora/schema.ts — merge the thread tables (auto-prefixed agent_threads / agent_messages):
export default defineSchema({ ... }).extend(agentExtension);

// start a run from a mutation/action:
const { id } = await ctx.agents.support.run({ input: message, owner: ctx.auth.userId, threadKey });

// watch it live from the client (every turn, tool call, and reply streams in):
useSubscription(api.agents.agentMessages, { key: threadKey });
```

## Why durable

- A **completed** step is memoized by Cloudflare Workflows — a resumed run never re-executes a finished tool call (no double-charged card).
- A **failed** step is retried at-least-once — side-effecting tools receive their deterministic step name as `ctx.idempotencyKey` to dedupe on.
- Message writes are keyed and idempotent — replays never duplicate the thread.
- Owned threads (`owner: ctx.auth.userId`) are readable only by their owner — a mismatch looks like a missing thread.
- The 10-minute action ceiling doesn't exist here: slow tools and long loops are just workflow steps.

See the package docs for the full API.

## License

FSL-1.1-Apache-2.0
