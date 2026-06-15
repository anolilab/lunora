# @lunora/container

Cloudflare Containers for Lunora: `defineContainer`, generated Container DO classes, and the `ctx.containers` action surface.

Part of the [Lunora](https://github.com/anolilab/lunora) framework.

## Usage

Declare containers in `lunora/containers.ts`:

```ts
import { defineContainer } from "@lunora/container";

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

The config layer (`lunora dev` / `lunora deploy`) reconciles the wrangler `containers[]` entry, the `CONTAINER_*` Durable Object binding, and the SQLite-class migration automatically; `wrangler deploy` builds the Dockerfile with local Docker and pushes it to the Cloudflare Registry.

## Calling Lunora from inside a container

Container code calls back into your app's functions with the bridge client (any JS runtime), over the Worker's HTTP RPC endpoint:

```ts
import { createContainerBridge } from "@lunora/container/bridge";

const lunora = createContainerBridge({ baseUrl: process.env.LUNORA_URL!, token: process.env.LUNORA_TOKEN });

const pending = await lunora.query("jobs:listPending", { limit: 10 });
await lunora.mutation("jobs:markDone", { id: pending[0].id });
```

The token is a bearer your Worker's `resolveIdentity` recognizes — pass it to the container as a `secret`. Non-JS containers can `POST /_lunora/rpc` with `{ functionPath, args }` directly.

Secure the bridge in `resolveIdentity`: read `request.headers.get("authorization")`, strip the `Bearer ` prefix, and compare the token against a Worker secret (e.g. `env.LUNORA_CONTAINER_TOKEN`) you also forward to the container. Return a `{ userId }` identity only on a match and `null` otherwise — an unrecognised request then runs anonymously and is rejected by your functions' own authorization checks. See [Securing the bridge](https://lunora.sh/docs/addons/containers#securing-the-bridge) for the full example.

## Entry points

- `@lunora/container` — Node-safe: `defineContainer`, naming/normalization helpers, `createContainerContext`, and the Docker-free `createContainerTestContext` test double.
- `@lunora/container/do` — workerd-only: the `LunoraContainer` base class the generated DO classes extend (pulls in `@cloudflare/containers`).
- `@lunora/container/bridge` — runtime-agnostic: `createContainerBridge` for calling Lunora functions from inside a container.
