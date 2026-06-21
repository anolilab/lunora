<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="workflow" />

</a>

<h3 align="center">Durable workflows for Lunora: defineWorkflow over Cloudflare Workflows, generated WorkflowEntrypoint classes, and the ctx.workflows surface</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

Durable workflows for Lunora, built on [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) (GA durable execution).

`defineWorkflow` lets you author a multi-step, durable program whose steps are **memoized and retried** automatically and that **survives Worker restarts and redeploys**. Codegen emits the `WorkflowEntrypoint` class and wires the typed `ctx.workflows` handle; `@lunora/config` reconciles the `[[workflows]]` binding.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/workflow
```

```sh
yarn add @lunora/workflow
```

```sh
pnpm add @lunora/workflow
```

## Usage

### Authoring

```ts
// lunora/workflows.ts
import { defineWorkflow } from "@lunora/workflow";
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
- `ctx.run(ref, args, opts?)` — call a Lunora query / mutation / action; wrap in `ctx.step.do(...)` for durability.
- `ctx.runStep(step, args, opts?)` — run a reusable, schema-validated `defineStep` as a durable step (see below).
- `ctx.event` / `ctx.params` — the triggering event and its payload.
- `ctx.env` — the Worker bindings.
- `ctx.log` — a workflow-prefixed logger surfaced in `wrangler tail` / Studio.

### Reusable steps (`defineStep`)

A step authored inline with `ctx.step.do("name", () => …)` is fine for one-offs, but `defineStep` lets you define a step **once** — schema-validated and reusable across workflows. Args are validated (with `@lunora/values`) **before** the body runs, and the return value is validated **after** (when you declare `returns`), so a bad payload fails fast instead of corrupting later steps. Scaffold one with `vis generate lunora-step --name=chargeOrder` (appends to `lunora/steps.ts`), or write it by hand:

```ts
// lunora/steps.ts
import { defineStep } from "@lunora/workflow";
import { v } from "@lunora/values";

import { api } from "./_generated/api";

export const charge = defineStep("charge", {
    args: { orderId: v.string(), amount: v.number() },
    returns: v.object({ receiptId: v.string() }),
    config: { retries: { limit: 3, backoff: "exponential", delay: "10 seconds" } },
    handler: async (ctx, { orderId, amount }) => {
        if (ctx.attempt > 1) ctx.log.warn(`retrying charge for ${orderId}`);
        return ctx.run(api.payments.charge, { orderId, amount });
    },
    // Compensation — runs if a *later* step fails after this one committed.
    rollback: async (ctx) => {
        await ctx.run(api.payments.refund, { orderId: ctx.args.orderId });
    },
});
```

Run it from a workflow body — `ctx.runStep` wraps it in a durable `step.do(...)` for you:

```ts
export const orderPipeline = defineWorkflow<{ orderId: string }>({
    handler: async (ctx) => {
        const { receiptId } = await ctx.runStep(charge, { orderId: ctx.params.orderId, amount: 4200 });
        return { receiptId };
    },
});
```

The step handler context gives you `ctx.attempt` (1-based retry counter), `ctx.config`, `ctx.env`, `ctx.run`, `ctx.log`, and `ctx.step` (`{ name, count }`). Pass `ctx.runStep(step, args, { config })` to override the step's durability config for a single call.

### Rollback (saga compensation)

A step's optional `rollback` handler is forwarded to Cloudflare's **native** step rollback — it runs when a later step in the same instance fails, letting you undo a committed side effect (refund a charge, delete an uploaded object). The rollback context carries the original `args`, the `error` that triggered it, the step's `output` (if it completed), and `env` / `run` / `log`. Cloudflare owns rollback ordering and execution; `defineStep` just wires the handler and an optional `rollbackConfig`.

### Failing without retries (`NonRetryableError`)

Throw `NonRetryableError` from a step or the handler to fail the instance immediately, skipping retries — the portable, Node-importable mirror of `cloudflare:workflows`' native error (so your workflow code stays unit-testable). The runtime converts it to the native error at the workflow boundary.

```ts
import { defineStep, NonRetryableError } from "@lunora/workflow";
import { v } from "@lunora/values";

import { api } from "./_generated/api";

export const charge = defineStep("charge", {
    args: { orderId: v.string() },
    handler: async (ctx, { orderId }) => {
        const order = await ctx.run(api.orders.get, { id: orderId });
        if (order.status === "cancelled") {
            throw new NonRetryableError("order cancelled — retrying will never succeed");
        }
        return ctx.run(api.payments.charge, { orderId });
    },
});
```

### Starting instances

Codegen wires a typed `ctx.workflows` handle onto mutations and actions. Resolve a handle by export name and start an instance:

```ts
// lunora/orders.ts
import { mutation, v } from "./_generated/server";

export const checkout = mutation.input({ orderId: v.string() }).mutation(async ({ ctx, args: { orderId } }) => {
    const instance = await ctx.workflows.get<{ orderId: string }>("orderPipeline").create({ params: { orderId } });

    return { instanceId: instance.id };
});
```

A handle exposes `create({ id?, params?, retention? })`, `createBatch([...])`, and `get(id)`. An instance handle exposes its lifecycle: `status()`, `pause()`, `resume()`, `terminate()`, and `sendEvent({ type, payload })` (to satisfy a `waitForEvent`).

### Runtime requirements

`ctx.run` dispatches back into the Worker, so the workflow's `env` must carry:

- `LUNORA_ORIGIN_URL` — where the Worker is mounted.
- `LUNORA_ADMIN_TOKEN` — the admin bearer the dispatch endpoint accepts.

### Manual wiring (without codegen)

1. Author `lunora/workflows.ts` as above.
2. Re-export the generated class from your worker entry — wrangler requires every `workflows[].class_name` to be exported:

    ```ts
    import LunoraWorkflow from "@lunora/workflow/do";
    import { orderPipeline } from "./lunora/workflows";

    export class OrderPipelineWorkflow extends LunoraWorkflow {
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

The `workflowClassName` / `workflowBindingName` / `workflowDefaultName` helpers produce exactly these names so codegen and config never disagree.

### Observing instances (REST client)

The Worker `Workflow` binding can only `create`/`get` an instance and read one instance's status — it has no instance list and no per-step detail. To list instances or read a step timeline, use `createWorkflowsRestClient`, which talks to Cloudflare's account-scoped Workflows REST API. The API token is a secret, so this runs server-side only (the Studio reaches it through the admin-gated runtime proxy).

```ts
import { createWorkflowsRestClient } from "@lunora/workflow";

const client = createWorkflowsRestClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN, // scope: Workflows Read (Edit for setInstanceStatus)
});

const page = await client.listInstances({ workflowName: "order-pipeline", status: "running" });
const detail = await client.getInstance({ workflowName: "order-pipeline", instanceId: page.instances[0].id });
await client.setInstanceStatus({ workflowName: "order-pipeline", instanceId: detail.id, action: "terminate" });
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/addons/workflows)**.

## Related

- [`@lunora/server`](https://www.npmjs.com/package/@lunora/server) — start workflows via `ctx.workflows` from a mutation or action.
- [`@lunora/scheduler`](https://www.npmjs.com/package/@lunora/scheduler) — `runAfter` / `runAt` + Cron Triggers for non-durable scheduling.
- [`@lunora/config`](https://www.npmjs.com/package/@lunora/config) — reconciles the `[[workflows]]` binding.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/lunora/issues) and check our [Contributing](https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/lunora/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Lunora workflow package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/workflow?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/workflow
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/workflow?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/workflow
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
