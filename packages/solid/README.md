# @cirrus/solid

SolidJS adapter for [Cirrus](https://github.com/anolilab/cirrus) — live queries, optimistic mutations, and reactive loaders.

Thin, idiomatic glue over the framework-neutral `@cirrus/client`. Solid's
fine-grained signals map directly onto Cirrus's per-subscription deltas, so a
live query is just a signal the WebSocket writes to.

## Surface

| Export             | What it does                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `CirrusProvider`   | Context provider carrying the `CirrusClient`.                                                  |
| `useCirrus()`      | Read the client from the nearest provider.                                                     |
| `createQuery`      | A live query accessor — opens a subscription, updates on every delta.                          |
| `createMutation`   | An optimistic mutation handle (`{ mutate, pending, data, error, reset }`).                     |
| `hydratePreloaded` | Seed a query from an SSR `Preloaded` token **synchronously** (no loading flash), then go live. |

## Quick start

```tsx
import { CirrusClient } from "@cirrus/client";
import { CirrusProvider, createQuery, createMutation } from "@cirrus/solid";
import { render, For } from "solid-js/web";

import { api } from "./cirrus/_generated/api";

const client = new CirrusClient({ url: window.location.origin });

function Messages() {
    const messages = createQuery(api.messages.list, { channelId: "channel:demo" }, { shardKey: "channel:demo" });
    const send = createMutation(api.messages.send);

    return <For each={messages()?.messages ?? []}>{(m) => <li>{m.text}</li>}</For>;
}

render(
    () => (
        <CirrusProvider client={client}>
            <Messages />
        </CirrusProvider>
    ),
    document.getElementById("root")!,
);
```

## Reactive loaders (SSR)

The killer feature: your loaders are live. A SolidStart route loader preloads a
query on the server (read-your-writes SSR); the client hydrates it with **no
refetch and no flash**, then the same data goes live over the WebSocket.

```ts
// route loader (server)
import { createServerClient, preloadQuery } from "@cirrus/client";

const client = createServerClient({ url: workerUrl, fetch: cookieForwardingFetch });
const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });
return { preloaded };
```

```tsx
// component (client)
import { hydratePreloaded } from "@cirrus/solid";

const data = hydratePreloaded(props.preloaded); // seeded from SSR, then live
```

`createServerClient` / `preloadQuery` are framework-neutral and live in
`@cirrus/client`.
