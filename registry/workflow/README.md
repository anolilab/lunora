# workflow

Durable, long-running workflows for Lunora. Declare a `defineWorkflow` export in `lunora/workflows.ts` and `@lunora/codegen` discovers it — generating a typed `WorkflowEntrypoint` class, a typed `ctx.workflows.get("<name>")` on mutation/action context, and the matching `workflows[]` entries in `wrangler.jsonc`.

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

- **`ctx.workflows.get("<name>")`** — a typed `WorkflowHandle` on Mutation and Action contexts. The generated overload accepts only your declared export names, and infers each one's `params`.
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
        await ctx.step.do("charge", async () => {
            /* ... */
        });
        return { status: "completed" };
    },
});
```

- **`step.do(name, fn)`** — a durable, retried unit of work. If the Worker restarts, execution resumes from the last completed step.
- **`step.sleep(name, duration)`** — pauses the workflow without costing CPU. Duration is a human-readable string like `"30 seconds"`, `"5 minutes"`, or `"2 hours"`.
- **`ctx.params`** — the input parameters passed when starting the workflow.
- **`ctx.run(func, args)`** (calling a Lunora function from within a step) — dispatches a query, mutation, or action and awaits its result.

Start a workflow from any mutation or action. `get(name)` resolves the handle; `create()` starts an instance:

```ts
const instance = await ctx.workflows.get("orderPipeline").create({ params: { orderId: "ord_123" } });
const status = await instance.status();
```

`createBatch([...])` starts many in one RPC, `get(id)` returns a handle to a running instance, and `sendEvent(id, event, payload)` delivers a `defineWorkflowEvent` the body is waiting on.

### Fan-out with `branch()`

Parallel work runs as **separate child workflow instances**, not as closures — each branch names another declared workflow. Build them with the top-level `branch()` and await them through `ctx.parallel`:

```ts
import { branch, defineWorkflow } from "@lunora/workflow";

export const reportWorkflow = defineWorkflow<{ userIds: string[] }, { results: unknown[] }>({
    handler: async (ctx) => {
        const results = await ctx.parallel(ctx.params.userIds.map((userId) => branch<{ processed: boolean }>("processUser", { userId })));

        return { results };
    },
});
```

## Configuration

| Option    | Type                                 | Description                                                                                             |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `handler` | `(ctx: WorkflowCtx) => Promise\<T\>` | The workflow logic — a function of steps.                                                               |
| `name`    | `string`                             | Override the deployed `workflows[].name` (defaults to the kebab-cased export name). Not a timeout knob. |

`defineWorkflow` takes no `timeout`: a wall-clock bound belongs to a step (`ctx.step.do(name, { timeout }, fn)`), a `waitForEvent`, or a `branch(..., { timeout })`.

Wrangler-level config (max concurrency, retry delays) is managed via the generated `wrangler.jsonc`.

## Adding more workflows

Each `defineWorkflow()` export in `lunora/workflows.ts` is discovered independently:

```ts
export const orderPipeline = defineWorkflow<...>({ handler: ... });
export const onboardingFlow = defineWorkflow<...>({ handler: ... });
export const dataSyncJob = defineWorkflow<...>({ handler: ... });
```

Codegen adds a `ctx.workflows.get("<name>")` overload for each — so a typo is a compile error, not a runtime one — and syncs all wrangler bindings.

## What you own

`lunora/workflows.ts` is copied into your repo — change the handler, add or remove workflows, add more steps, fan out with branches, or wire in different business logic however you like. `@lunora/workflow` provides the durable workflow runtime; this component is the idiomatic Lunora glue that turns it into `ctx.workflows.*`.
