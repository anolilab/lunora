# @cirrus/workflow

Durable workflows for Cirrus, built on [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) (GA durable execution).

`defineWorkflow` lets you author a multi-step, durable program whose steps are
**memoized and retried** automatically and that **survives Worker restarts and
redeploys**. Codegen emits the `WorkflowEntrypoint` class and wires the typed
`ctx.workflows` handle; `@cirrus/config` reconciles the `[[workflows]]` binding.

## Authoring

```ts
// cirrus/workflows.ts
import { defineWorkflow } from "@cirrus/workflow";
import { api } from "./_generated/api";

export const orderPipeline = defineWorkflow<{ orderId: string }>({
    handler: async (ctx) => {
        // ctx.step.do(...) is the durability boundary — memoized + retried.
        const order = await ctx.step.do("load", () => ctx.run(api.orders.get, { id: ctx.params.orderId }));

        await ctx.step.sleep("cool-off", "1 minute");

        await ctx.step.do("charge", () => ctx.run(api.payments.charge, { orderId: ctx.params.orderId }));

        // Hibernate until an external event arrives (webhook, approval, …).
        const shipped = await ctx.step.waitForEvent<{ trackingId: string }>("await-shipment", { type: "shipment.created" });

        return { order, trackingId: shipped.payload.trackingId };
    },
});
```

The handler context bundles:

- `ctx.step` — the native Cloudflare durable-step API (`do` / `sleep` / `sleepUntil` / `waitForEvent`).
- `ctx.run(ref, args, opts?)` — call a Cirrus query / mutation / action; wrap in `ctx.step.do(...)` for durability.
- `ctx.event` / `ctx.params` — the triggering event and its payload.
- `ctx.env` — the Worker bindings.
- `ctx.log` — a workflow-prefixed logger surfaced in `wrangler tail` / Studio.

## Starting instances

From a mutation or action, `ctx.workflows` resolves a handle by export name:

```ts
const instance = await ctx.workflows.get<{ orderId: string }>("orderPipeline").create({ params: { orderId } });
const status = await instance.status();
```

## Runtime requirements

`ctx.run` dispatches back into the Worker, so the workflow's `env` must carry:

- `CIRRUS_ORIGIN_URL` — where the Worker is mounted.
- `CIRRUS_ADMIN_TOKEN` — the admin bearer the dispatch endpoint accepts.

## Manual wiring (without codegen)

1. Author `cirrus/workflows.ts` as above.
2. Re-export the generated class from your worker entry — wrangler requires every
   `workflows[].class_name` to be exported:

    ```ts
    import CirrusWorkflow from "@cirrus/workflow/do";
    import { orderPipeline } from "./cirrus/workflows";

    export class OrderPipelineWorkflow extends CirrusWorkflow {
        constructor(ctx: ExecutionContext, env: Record<string, unknown>) {
            super(ctx, env, orderPipeline, "orderPipeline");
        }
    }
    ```

3. Add the binding to `wrangler.jsonc`:

    ```jsonc
    {
        "workflows": [{ "name": "order-pipeline", "binding": "WORKFLOW_ORDER_PIPELINE", "class_name": "OrderPipelineWorkflow" }],
    }
    ```

4. Build `ctx.workflows` from the binding: `createWorkflows({ bindings: { orderPipeline: env.WORKFLOW_ORDER_PIPELINE } })`.

The `workflowClassName` / `workflowBindingName` / `workflowDefaultName` helpers
produce exactly these names so codegen and config never disagree.
