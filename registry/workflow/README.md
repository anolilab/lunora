# workflow

Durable, long-running workflows for Lunora. Declare a `defineWorkflow` export in `lunora/workflows.ts` and `@lunora/codegen` discovers it — generating a typed `WorkflowEntrypoint` class, `ctx.workflows.<name>.start(params)` on mutation/action context, and the matching `workflows[]` entries in `wrangler.jsonc`.

Built on [`@lunora/workflow`](../../packages/workflow) — the durable workflow runtime over Cloudflare Workflows.

## Install

```bash
lunora registry add workflow
```

This:

1. Adds `@lunora/workflow` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/workflows.ts` (the `orderPipeline` declaration) into your project — this is **yours** to edit.

Then regenerate types:

```bash
lunora codegen
```

Codegen discovers the `defineWorkflow()` calls and emits:

- **`ctx.workflows.<name>.start(params)`** — typed producer on Mutation and Action contexts.
- **`WorkflowEntrypoint`** subclass in the generated Worker entry.
- **`workflows[]`** — wrangler bindings, auto-reconciled.

## How it works

`lunora/workflows.ts` exports workflow declarations built with `defineWorkflow`:

```ts
import { defineWorkflow } from "@lunora/workflow";

export const orderPipeline = defineWorkflow<{ orderId: string }, { status: string }>({
    handler: async (ctx) => {
        await ctx.step.do("load-order", async () => {
            return { id: ctx.params.orderId, total: 2999 };
        });
        await ctx.step.sleep("cool-off", "30 seconds");
        await ctx.step.do("charge", async () => { /* ... */ });
        return { status: "completed" };
    },
});
```

- **`step.do(name, fn)`** — a durable, retried unit of work. If the Worker restarts, execution resumes from the last completed step.
- **`step.sleep(name, duration)`** — pauses the workflow without costing CPU. Duration is a human-readable string like `"30 seconds"`, `"5 minutes"`, or `"2 hours"`.
- **`ctx.params`** — the input parameters passed when starting the workflow.
- **`ctx.run(func, args)`** (calling a Lunora function from within a step) — dispatches a query, mutation, or action and awaits its result.

Start a workflow from any mutation or action:

```ts
const handle = await ctx.workflows.orderPipeline.start({ orderId: "ord_123" });
const status = await handle.status();
```

### Fan-out with `branch()`

For parallel work, use `branch()` to spawn concurrent branches:

```ts
export const reportWorkflow = defineWorkflow<{ userIds: string[] }, { results: unknown[] }>({
    handler: async (ctx) => {
        const branches = ctx.params.userIds.map((userId) =>
            ctx.step.branch(`process-${userId}`, async () => {
                // Each branch runs independently
                return { userId, processed: true };
            }),
        );
        const results = await Promise.all(branches);
        return { results };
    },
});
```

## Configuration

| Option      | Type                                  | Description                                          |
|-------------|---------------------------------------|------------------------------------------------------|
| `handler`   | `(ctx: WorkflowCtx) => Promise\<T\>` | The workflow logic — a function of steps.             |
| `timeout`   | `string`                              | Max wall-clock duration (e.g. `"15 minutes"`).       |

Wrangler-level config (max concurrency, retry delays) is managed via the generated `wrangler.jsonc`.

## Adding more workflows

Each `defineWorkflow()` export in `lunora/workflows.ts` is discovered independently:

```ts
export const orderPipeline = defineWorkflow<...>({ handler: ... });
export const onboardingFlow = defineWorkflow<...>({ handler: ... });
export const dataSyncJob = defineWorkflow<...>({ handler: ... });
```

Codegen generates a separate `ctx.workflows.<name>` starter for each and syncs all wrangler bindings.

## What you own

`lunora/workflows.ts` is copied into your repo — change the handler, add or remove workflows, add more steps, fan out with branches, or wire in different business logic however you like. `@lunora/workflow` provides the durable workflow runtime; this component is the idiomatic Lunora glue that turns it into `ctx.workflows.*`.
