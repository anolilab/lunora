# flags

OpenFeature feature flags for Lunora. Declares a `defineFlags()` provider in `lunora/flags.ts` and codegen discovers it, which wires `ctx.flags` onto every query, mutation, and action context — so your functions can read typed flags without any manual wiring.

Built on [`@lunora/flags`](../../packages/flags) with an **in-memory provider** out of the box (perfect for dev). Swap to Cloudflare **Flagship** for production flag management with a single provider change.

## Install

```bash
lunora registry add flags
```

This:

1. Adds `@lunora/flags` and `@lunora/server` to your `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/flags.ts` (the `defineFlags()` declaration) into your project — this is **yours** to edit.

Then regenerate types:

```bash
lunora codegen
```

Codegen discovers the `defineFlags()` call in `lunora/flags.ts` by AST and wires `ctx.flags` onto every context. You never edit context types by hand.

## How it works

`lunora/flags.ts` default-exports the result of `defineFlags()`:

```ts
export default defineFlags({
    provider: memoryProvider({
        "dark_mode": { defaultValue: false, type: "boolean" },
        "page_size": { defaultValue: 25, type: "number" },
        "beta_features": { defaultValue: false, type: "boolean" },
    }),
    identify: (auth) => auth.userId ?? undefined,
});
```

- **`provider`** — the OpenFeature provider that returns flag values. The shipped config uses `memoryProvider` (plain static values, no network calls). For production, swap to `flagshipProvider({ binding: "FLAGS" })`.
- **`identify`** — a function that derives the OpenFeature targeting key from `auth` (the current request's authentication context). Used for gradual rollouts and targeted flag overrides.

### Reading flags

`ctx.flags` exposes typed readers matching OpenFeature's standard API:

```ts
const darkMode = await ctx.flags.boolean("dark_mode", false);
const pageSize = await ctx.flags.number("page_size", { defaultValue: 25 });
const greeting = await ctx.flags.string("greeting", { defaultValue: "Hello" });
const config = await ctx.flags.object("feature_config", { defaultValue: {} });
```

Each reader returns the evaluated value, optionally merged with `details` (the OpenFeature `EvaluationDetails` with reason, variant, etc.):

```ts
const { value, variant, reason } = await ctx.flags.boolean("dark_mode", false, { details: true });
```

### Client-side hooks

The `@lunora/flags` package ships framework hooks for React, Vue, Solid, and Svelte:

```tsx
// React
import { useFlag } from "@lunora/react";

function App() {
    const { value: darkMode } = useFlag("dark_mode", false);
    return <div className={darkMode ? "dark" : "light"}>…</div>;
}
```

## Production — Cloudflare Flagship

For a managed flag evaluation service with gradual rollouts, A/B testing, and a dashboard:

1. Provision a Cloudflare Flagship account and create a flag set.
2. Add the `FLAGS` binding to your `wrangler.jsonc`:

    ```jsonc
    {
        "flagship": [{ "binding": "FLAGS" }],
    }
    ```

3. Swap the provider in `lunora/flags.ts`:

    ```ts
    import { flagshipProvider } from "@lunora/flags/providers/flagship";

    export default defineFlags({
        provider: flagshipProvider({ binding: "FLAGS" }),
        identify: (auth) => auth.userId ?? undefined,
    });
    ```

The `identify` function is forwarded to Flagship as the targeting key, so gradual rollouts and user-segment overrides work.

## Providers reference

| Provider              | Import                                  | Use case                          |
|-----------------------|-----------------------------------------|-----------------------------------|
| `memoryProvider`      | `@lunora/flags/providers/memory`        | Local dev, static overrides       |
| `envProvider`         | `@lunora/flags/providers/env`           | Env-var-driven flags              |
| `flagshipProvider`    | `@lunora/flags/providers/flagship`      | Production Flagship               |

Any OpenFeature-compatible provider works — pass it to the `provider` key.

## Studio integration

The installed flags appear in the **Lunora Studio** under the Flags tab (a read-only view). You can see every declared flag, its current value, and its type at a glance. Flagship-backed flags also show the evaluation reason and the targeting key.

## What you own

`lunora/flags.ts` is copied into your repo — change the provider, add or remove flags, wire in a custom OpenFeature provider, or change the targeting logic however you like. `@lunora/flags` provides the OpenFeature integration and framework hooks; this component is the idiomatic Lunora glue that turns it into `ctx.flags.*`.
