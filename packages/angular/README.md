# @lunora/angular

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

Angular reactive adapter for Lunora — signal-based live queries and mutations.

Thin, idiomatic glue over the framework-neutral `@lunora/client`. Angular signals
map directly onto Lunora's per-subscription deltas, so a live query is just a
`signal` the WebSocket writes to.

## Install

```bash
pnpm add @lunora/angular
```

`@angular/core` is a peer dependency (the host app supplies the Angular runtime).

## Wire the client

Add `provideLunora` to your application config. It defaults to the page origin
(the single-worker deploy where `/_lunora/ws` loops back into the app's own
worker); pass options to point at a remote URL.

```ts
import { provideLunora } from "@lunora/angular";

export const appConfig: ApplicationConfig = {
    providers: [provideLunora(/* { url: "https://api.example.com" } */)],
};
```

## Live queries

`liveQuery` opens a subscription and mirrors every server delta into a `signal`.
It tears the subscription down automatically when the component is destroyed
(`DestroyRef.onDestroy`). Call it from an injection context — a component/service
field initializer or constructor.

```ts
import { Component } from "@angular/core";
import { liveQuery } from "@lunora/angular";

import { api } from "../lunora/_generated/api";

@Component({
    selector: "app-messages",
    standalone: true,
    template: `@for (m of messages()?.messages ?? []; track m.id) {
        <p>{{ m.text }}</p>
    }`,
})
export class MessagesComponent {
    readonly messages = liveQuery(api.messages.list, { channelId: "general" });
}
```

Pass `"skip"` as the args to short-circuit (no network call, no socket).

## Mutations

```ts
import { injectLunoraClient, mutate } from "@lunora/angular";

@Component({/* … */})
export class Composer {
    private readonly client = injectLunoraClient();

    send(text: string) {
        // Capture the client in a field: mutations fire from event handlers,
        // which run outside an injection context.
        return mutate(api.messages.send, { text }, { client: this.client });
    }
}
```

Optimistic updates (`optimistic` / `optimisticUpdate`) and the offline queue pass
straight through to `client.mutation`.

## Connection status

```ts
import { connectionStatus } from "@lunora/angular";

readonly status = connectionStatus(); // Signal<"idle" | "connecting" | "connected" | "offline">
```

Part of the [Lunora](https://github.com/anolilab/lunora) framework.
