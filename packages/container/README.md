# @cirrus/container

Cloudflare Containers for Cirrus: `defineContainer`, generated Container DO classes, and the `ctx.containers` action surface.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

## Usage

Declare containers in `cirrus/containers.ts`:

```ts
import { defineContainer } from "@cirrus/container";

export const transcoder = defineContainer({
    image: "./containers/transcoder", // dir with a Dockerfile, or { registry: "docker.io/acme/transcoder:1.4" }
    defaultPort: 8080,
    instanceType: "standard-1",
    maxInstances: 5,
    sleepAfter: "5m",
    secrets: ["TRANSCODER_API_KEY"], // forwarded from Worker secrets / .dev.vars
});
```

Codegen emits the Container Durable Object class into `_generated/containers.ts` (re-export it from your worker entry) and wires a typed handle onto `ActionCtx`:

```ts
export const transcode = action({
    args: { videoId: v.id("videos") },
    handler: async (ctx, { videoId }) => {
        // one instance per entity
        const res = await ctx.containers.transcoder.get(videoId).fetch("/transcode", { method: "POST" });

        // or a random instance from a fixed pool
        const probe = await ctx.containers.transcoder.any().fetch("/healthz");
    },
});
```

The config layer (`cirrus dev` / `cirrus deploy`) reconciles the wrangler `containers[]` entry, the `CONTAINER_*` Durable Object binding, and the SQLite-class migration automatically; `wrangler deploy` builds the Dockerfile with local Docker and pushes it to the Cloudflare Registry.

## Entry points

- `@cirrus/container` — Node-safe: `defineContainer`, naming/normalization helpers, `createContainerContext`, and the Docker-free `createContainerTestContext` test double.
- `@cirrus/container/do` — workerd-only: the `CirrusContainer` base class the generated DO classes extend (pulls in `@cloudflare/containers`).
