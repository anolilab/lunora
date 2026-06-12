<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="react" />

</a>

<h3 align="center">React hooks for Cirrus: useQuery, useMutation, useSubscription, and useAuth</h3>

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

React hooks for Cirrus — `useQuery`, `useMutation`, `useSubscription`, `useAuth`, and more — that wrap a `@cirrus/client` instance behind a `CirrusProvider`. The hooks are client-only; server-side data loading lives in the socket-free `@cirrus/react/server` entry.

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework — a type-safe, real-time backend on Cloudflare Workers + Durable Objects with a Vite-first DX.

## Install

```sh
npm install @cirrus/react
```

```sh
yarn add @cirrus/react
```

```sh
pnpm add @cirrus/react
```

## Usage

```tsx
import { CirrusClient } from "@cirrus/client";
import { CirrusProvider, useMutation, useQuery } from "@cirrus/react";
import { api } from "./cirrus/_generated/api";

const client = new CirrusClient({ url: "https://app.acme.test" });

export function App() {
    return (
        <CirrusProvider client={client}>
            <MessageList room="general" />
        </CirrusProvider>
    );
}

function MessageList({ room }: { room: string }) {
    const messages = useQuery(api.messages.list, { room });
    const { mutate, pending } = useMutation(api.messages.send);

    if (messages === undefined) return <p>Loading…</p>;

    return (
        <>
            <ul>
                {messages.map((m) => (
                    <li key={m.id}>{m.body}</li>
                ))}
            </ul>
            <button disabled={pending} onClick={() => mutate({ room, body: "hi" })}>
                Send
            </button>
        </>
    );
}
```

> This README covers the basics. For the full API, options, and guides, see the **[documentation](https://cirrus.dev/docs/api/react)**.

## Related

- [`@cirrus/client`](https://www.npmjs.com/package/@cirrus/client) — the browser SDK these hooks wrap.
- [`@cirrus/query-core`](https://www.npmjs.com/package/@cirrus/query-core) — shared live-query state machine.
- [`@cirrus/ssr`](https://www.npmjs.com/package/@cirrus/ssr) — server-side preloading used by `@cirrus/react/server`.

## Supported Node.js Versions

Libraries in this ecosystem make the best effort to track [Node.js' release schedule](https://github.com/nodejs/release#release-schedule).
Here's [a post on why we think this is important](https://medium.com/the-node-js-collection/maintainers-should-consider-following-node-js-release-schedule-ab08ed4de71a).

## Contributing

If you would like to help take a look at the [list of issues](https://github.com/anolilab/cirrus/issues) and check our [Contributing](https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md) guidelines.

> **Note:** please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Credits

- [Daniel Bannert](https://github.com/prisis)
- [All Contributors](https://github.com/anolilab/cirrus/graphs/contributors)

## Made with ❤️ at Anolilab

This is an open source project and will always remain free to use. If you think it's cool, please star it 🌟. [Anolilab](https://www.anolilab.com/open-source) is a Development and AI Studio. Contact us at [hello@anolilab.com](mailto:hello@anolilab.com) if you need any help with these technologies or just want to say hi!

## License

The Cirrus react package is open-sourced software licensed under the [FSL-1.1-Apache-2.0][license].

<!-- badges -->

[license-badge]: https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue.svg?style=for-the-badge
[license]: https://github.com/anolilab/cirrus/blob/alpha/LICENSE.md
[npm-version-badge]: https://img.shields.io/npm/v/@cirrus/react?style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@cirrus/react
[npm-downloads-badge]: https://img.shields.io/npm/dm/@cirrus/react?style=for-the-badge
[npm-downloads]: https://www.npmjs.com/package/@cirrus/react
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/anolilab/cirrus/blob/alpha/.github/CONTRIBUTING.md
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
