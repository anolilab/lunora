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
- `ctx.event` / `ctx.params` — the triggering event and its payload.
- `ctx.env` — the Worker bindings.
- `ctx.log` — a workflow-prefixed logger surfaced in `wrangler tail` / Studio.

### Starting instances

From a mutation or action, `ctx.workflows` resolves a handle by export name:

```ts
const instance = await ctx.workflows.get<{ orderId: string }>("orderPipeline").create({ params: { orderId } });
const status = await instance.status();
```

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
