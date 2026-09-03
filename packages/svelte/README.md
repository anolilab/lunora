<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="svelte" />

</a>

<h3 align="center">Svelte adapter for Lunora — live stores, optimistic mutations, and reactive loaders</h3>

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

The Svelte adapter for Lunora. Thin, idiomatic glue over the framework-neutral `@lunora/client`, re-expressed as Svelte stores you read with the `$store` idiom: live query stores, optimistic mutations, and a `hydratePreloaded` SSR handoff. Plain `.ts` over stores — no `.svelte` compiler is required to build or test it.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/svelte
```

```sh
yarn add @lunora/svelte
```

```sh
pnpm add @lunora/svelte
```

## Usage

Provide the client once at the root (`setContext` must run during component init):

```svelte
<!-- +layout.svelte -->
<script lang="ts">
    import { LunoraClient } from "@lunora/client";
    import { setLunoraClient } from "@lunora/svelte";

    setLunoraClient(new LunoraClient({ url: import.meta.env.VITE_LUNORA_URL }));
</script>

<slot />
```

Then read a live query and run a mutation in any descendant component:

```svelte
<!-- Messages.svelte -->
<script lang="ts">
    import { query, mutation } from "@lunora/svelte";
    import { api } from "$lib/_generated/api";

    // `$messages` updates on every server delta; `undefined` until the first response.
    const messages = query(api.messages.list, { room: "general" });
    const { mutate, pending } = mutation(api.messages.send);
</script>

<ul>
    {#each $messages ?? [] as m (m._id)}
        <li>{m.text}</li>
    {/each}
</ul>
<button disabled={$pending} on:click={() => mutate({ room: "general", text: "hi" })}>Send</button>
```

The `api.*` references come from `$lib/_generated/api`, emitted by codegen from your `lunora/schema.ts` and functions.

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/frameworks/reactive-loaders)**.

## API

All functions that require a component lifecycle (presence, rate-limit) return a `teardown()` function. Call it from `onDestroy(handle.teardown)` to clean up intervals and subscriptions.

| Function           | React equivalent      | Description                                                                            |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------- |
| `setLunoraClient`  | `LunoraProvider`      | Store the ambient `LunoraClient` in Svelte context.                                    |
| `getLunoraClient`  | `useLunora`           | Read the ambient `LunoraClient` from Svelte context.                                   |
| `query`            | `useQuery`            | Live readable store — updates on every server delta.                                   |
| `mutation`         | `useMutation`         | Optimistic mutation handle (`data`, `error`, `pending`, `mutate`, `reset` stores).     |
| `subscription`     | `useSubscription`     | Raw subscription readable — unbounded live stream.                                     |
| `paginatedQuery`   | `usePaginatedQuery`   | Cursor-paginated query with `loadMore`, `status`, `results`, and `error` stores.       |
| `infiniteQuery`    | `useInfiniteQuery`    | Infinite-scroll variant of `paginatedQuery`.                                           |
| `auth`             | `useAuth`             | Reactive auth stores (`user`, `token`) plus `setToken`.                                |
| `presence`         | `usePresence`         | Collaborative-awareness — heartbeat + live present-members readable + `teardown`.      |
| `flag`             | `useFlag`             | Live OpenFeature flag readable store — holds `default` until the server answers.       |
| `flags`            | `useFlags`            | Batch variant — a readable store of one value per key in the defaults map.             |
| `rateLimit`        | `useRateLimit`        | Client-side rate-limit mirror — `ok`, `disabled`, `retryAfter` readables + `teardown`. |
| `connectionStatus` | `useConnectionStatus` | Reactive connection state store.                                                       |
| `hydratePreloaded` | `usePreloadedQuery`   | Seed a query store from an SSR `Preloaded` token, then go live.                        |
| `agentToolEvents`  | `useAgentToolEvents`  | One agent thread's tool lifecycle as a readable store of discriminated events.         |
| `voiceAgent`       | `useVoiceAgent`       | Full-duplex voice call — stores for status/transcript/level + call controls.           |

`voiceAgent` opens nothing until `startCall()` — that call is what requests the microphone, so it must run from a user gesture. Unlike the other adapters there is **no auto-dispose**: call `onDestroy(call.endCall)` yourself to release the socket, the mic tracks and the Web Audio graph.

## Related

- [`@lunora/client`](https://www.npmjs.com/package/@lunora/client) — the framework-neutral browser SDK this adapter wraps.
- `@lunora/client/ssr` — the server preload contract behind `@lunora/svelte/server`.
- [`@lunora/react`](https://www.npmjs.com/package/@lunora/react) — the same contract for React.

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

The Lunora svelte package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/svelte?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/svelte
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/svelte?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/svelte
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
