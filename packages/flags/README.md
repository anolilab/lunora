# @lunora/flags

<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="flags" />

</a>

<h3 align="center">OpenFeature-based feature flags for Lunora — ctx.flags, useFlag, and a first-class Cloudflare Flagship provider with any OpenFeature provider pluggable</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

OpenFeature-based feature flags for [Lunora](https://lunora.sh). Configure one
OpenFeature provider in `lunora/flags.ts` and Lunora wires `ctx.flags` onto every
handler — Cloudflare [Flagship](https://github.com/cloudflare/flagship) is the
first-class default, but any OpenFeature provider plugs in unchanged.

## Install

```bash
pnpm add @lunora/flags @openfeature/server-sdk
# Flagship provider (default):
pnpm add @cloudflare/flagship
```

## Configure

```ts
// lunora/flags.ts
import { defineFlags } from "@lunora/flags";
import { flagshipProvider } from "@lunora/flags/providers/flagship";

export default defineFlags({
    provider: flagshipProvider({ binding: "FLAGS" }), // Workers binding mode — no HTTP, no token
    identify: (auth) => auth.userId ?? undefined, // default targetingKey
});
```

Binding mode reads `env.FLAGS`; configure it in `wrangler.jsonc`:

```jsonc
{ "flagship": [{ "binding": "FLAGS", "app_id": "<your-app-id>" }] }
```

HTTP mode (non-binding environments): `flagshipProvider({ appId, accountId, authToken })`.

Any OpenFeature provider works in place of Flagship:

```ts
export default defineFlags({ provider: (env) => new SomeOpenFeatureProvider(env.SOME_KEY) });
```

Two zero-dependency providers ship in the box for tests, local defaults, and
binding-driven flags:

```ts
import { memoryProvider } from "@lunora/flags/providers/memory";
import { envProvider } from "@lunora/flags/providers/env";

// Static key → value map (booleans, strings, numbers, JSON objects):
export default defineFlags({ provider: memoryProvider({ "dark-mode": true, "page-size": 25 }) });

// Read from the Worker env — `dark-mode` → `env.FLAG_DARK_MODE` (override with `prefix` / `name`):
export default defineFlags({ provider: envProvider() });
```

## Evaluate

```ts
export const listPosts = query(async (ctx) => {
    if (await ctx.flags.boolean("new-ranking", false)) {
        /* ... */
    }
    const hero = await ctx.flags.string("homepage-hero", "control", { plan: "premium" });
    const details = await ctx.flags.details.boolean("new-ranking", false); // value + reason + variant
});
```

`ctx.flags` never throws: a missing flag, type mismatch, or provider error resolves
with the `defaultValue`. It does not do so silently — a provider that fails to BIND
(a missing binding, an unset token, a throwing `initialize`) is logged through
`defineFlags({ logger })`, or on `console.error` when none is configured, since
otherwise a misconfigured deployment serves every flag at its checked-in default
with nothing to notice. The default `targetingKey` (from `identify`) is merged under
any per-call context, and identical evaluations within one request are memoized.

## Exports

| Export                             | Contents                                        | Peer dependency                                |
| ---------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `@lunora/flags`                    | `defineFlags`, `createFlags`, types             | `@openfeature/server-sdk`                      |
| `@lunora/flags/providers/flagship` | `flagshipProvider` (Cloudflare Flagship)        | `@cloudflare/flagship`                         |
| `@lunora/flags/providers/memory`   | `memoryProvider` (static `key → value` map)     | — (zero extra deps)                            |
| `@lunora/flags/providers/env`      | `envProvider` (reads flags from the Worker env) | — (zero extra deps)                            |
| `@lunora/flags/web`                | `FlagshipClientProvider` (browser escape hatch) | `@openfeature/web-sdk`, `@cloudflare/flagship` |

## License

[FSL-1.1-Apache-2.0](./LICENSE.md)
