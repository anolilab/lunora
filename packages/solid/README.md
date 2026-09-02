<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="solid" />

</a>

<h3 align="center">SolidJS adapter for Lunora — live queries, optimistic mutations, and reactive loaders</h3>

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

The SolidJS adapter for Lunora. Thin, idiomatic glue over the framework-neutral `@lunora/client` — Solid's fine-grained signals map directly onto Lunora's per-subscription deltas, so a live query is just a signal the WebSocket writes to. Ships `createQuery`, `createMutation`, and a `hydratePreloaded` SSR handoff.

Part of the [Lunora](https://github.com/anolilab/lunora) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @lunora/solid
```

```sh
yarn add @lunora/solid
```

```sh
pnpm add @lunora/solid
```

Requires `solid-js@^1.9.0 || ^2.0.0-rc.0` as a peer. A single build serves both
majors and the public API is identical on either; on Solid 2.0 the surrounding
imports move (`solid-js/web` → `@solidjs/web`, `solid-js/store` → `solid-js`).

## Usage

```tsx
import { LunoraClient } from "@lunora/client";
import { LunoraProvider, createQuery, createMutation } from "@lunora/solid";
import { For, render } from "solid-js/web";
import { api } from "./lunora/_generated/api";

const client = new LunoraClient({ url: window.location.origin });

function Messages() {
    // `messages()` reads `undefined` until the first server frame, then updates on every delta.
    const messages = createQuery(api.messages.list, { channelId: "channel:demo" });
    const send = createMutation(api.messages.send);

    return (
        <>
            <For each={messages()?.messages ?? []}>{(m) => <li>{m.text}</li>}</For>
            <button disabled={send.pending()} onClick={() => send.mutate({ channelId: "channel:demo", text: "hi" })}>
                Send
            </button>
        </>
    );
}

render(
    () => (
        <LunoraProvider client={client}>
            <Messages />
        </LunoraProvider>
    ),
    document.getElementById("root")!,
);
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://lunora.sh/docs/frameworks/reactive-loaders)**.

## API

| Primitive                                           | React equivalent      | Description                                                                       |
| --------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `LunoraProvider`                                    | `LunoraProvider`      | Context component — wraps your app tree with the `LunoraClient`.                  |
| `useLunora`                                         | `useLunora`           | Read the ambient `LunoraClient` from the nearest `LunoraProvider`.                |
| `createQuery`                                       | `useQuery`            | Live query signal — returns `() => T \| undefined`, re-subscribes on arg change.  |
| `createMutation`                                    | `useMutation`         | Optimistic mutation handle (`data`, `error`, `pending`, `mutate`, `reset`).       |
| `createSubscription`                                | `useSubscription`     | Raw subscription signal — unbounded live stream.                                  |
| `createPaginatedQuery`                              | `usePaginatedQuery`   | Cursor-paginated query with `loadMore`, `status`, `results`, and `error` signals. |
| `createInfiniteQuery`                               | `useInfiniteQuery`    | Infinite-scroll variant of `createPaginatedQuery`.                                |
| `createAuth`                                        | `useAuth`             | Reactive auth state (`token`, `user` signals + `setToken`).                       |
| `Authenticated` / `AuthLoading` / `Unauthenticated` | —                     | Auth-gate components rendering `children` per identity state.                     |
| `createPresence`                                    | `usePresence`         | Collaborative-awareness — heartbeat + live present-members signal.                |
| `createFlag`                                        | `useFlag`             | Live OpenFeature flag accessor — returns `default` until the server answers.      |
| `createFlags`                                       | `useFlags`            | Batch variant — an accessor of one value per key in the defaults map.             |
| `createRateLimit`                                   | `useRateLimit`        | Client-side rate-limit mirror — `ok`, `disabled`, `retryAfter` as signals.        |
| `createConnectionStatus`                            | `useConnectionStatus` | Reactive connection state signal.                                                 |
| `hydratePreloaded`                                  | `usePreloadedQuery`   | Seed a query synchronously from an SSR `Preloaded` token, then go live.           |
| `createAgentToolEvents`                             | `useAgentToolEvents`  | One agent thread's tool lifecycle as an `Accessor` of discriminated events.       |
| `createVoiceAgent`                                  | `useVoiceAgent`       | Full-duplex voice call — accessors for status/transcript/level + call controls.   |

`createVoiceAgent` opens nothing until `startCall()` — that call is what requests the microphone, so it must run from a user gesture. `endCall()` releases the socket, the mic tracks and the Web Audio graph, and `onCleanup` runs it for you when the owning root is disposed.

## Related

- [`@lunora/client`](https://www.npmjs.com/package/@lunora/client) — the framework-neutral browser SDK this adapter wraps.
- `@lunora/client/ssr` — the server preload contract behind `@lunora/solid/server`.
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

The Lunora solid package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/lunora/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@lunora/solid?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@lunora/solid
[npm-downloads-badge]: https://img.shields.io/npm/dm/@lunora/solid?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@lunora/solid
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/lunora/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
