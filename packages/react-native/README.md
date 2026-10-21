<div align="center">

# @lunora/react-native

**React Native / Expo integration for [Lunora](https://lunora.sh).**

</div>

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

---

The same live hooks you use on the web — `useQuery`, `useMutation`,
`useSubscription`, `useAuth`, `usePresence`, … — running on your phone, plus the
two seams a native app needs that a browser gives you for free: a durable offline
queue backed by `AsyncStorage`, and credentialed requests (the session is a
bearer, attached explicitly).

This package **re-exports the whole `@lunora/react` surface** (see
[below](#re-exported-lunorareact-surface)), so you import your hooks and
provider from here, and adds:

- `createLunoraClient(options)` — a `LunoraClient` factory tuned for React
  Native.
- `@lunora/react-native/auth` — a one-import bridge to the
  [better-auth Expo](https://www.better-auth.com/docs/integrations/expo) plugin.

## Install

```sh
pnpm add @lunora/react-native @lunora/react @tanstack/react-query react
# offline-queue persistence:
npx expo install @react-native-async-storage/async-storage
# only if you use auth:
npx expo install expo-secure-store expo-web-browser expo-linking expo-constants expo-network
pnpm add better-auth @better-auth/expo
```

## Quick start

```tsx
// lunora.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLunoraClient } from "@lunora/react-native";

export const client = createLunoraClient({
    url: process.env.EXPO_PUBLIC_LUNORA_URL!, // e.g. https://my-app.workers.dev
    storage: AsyncStorage, // persists offline writes across app restarts
});
```

```tsx
// App.tsx
import { LunoraProvider } from "@lunora/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { client } from "./lunora";
import { Chat } from "./Chat";

const queryClient = new QueryClient();

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <LunoraProvider client={client}>
                <Chat />
            </LunoraProvider>
        </QueryClientProvider>
    );
}
```

```tsx
// Chat.tsx
import { useMutation, useQuery } from "@lunora/react-native";
import { FlatList, Text } from "react-native";

import { api } from "./lunora/_generated/api";

export function Chat() {
    const messages = useQuery(api.messages.list, {});
    const { mutate: send } = useMutation(api.messages.send);

    return <FlatList data={messages ?? []} keyExtractor={(m) => m._id} renderItem={({ item }) => <Text>{item.text}</Text>} />;
}
```

`useQuery` opens a live WebSocket subscription — the list updates in place as
other clients write, and `send` is optimistic and offline-safe.

## Authentication (better-auth + Expo)

The session is sent as a **bearer** token: the HTTP RPC and the live socket's
upgrade both carry it in the `Authorization` header (see [Why a bearer token](#why-a-bearer-token)).

```tsx
// auth.ts
import { createAuthClient } from "better-auth/react";
import { expoClient } from "@lunora/react-native/auth";
import * as SecureStore from "expo-secure-store";

export const authClient = createAuthClient({
    baseURL: process.env.EXPO_PUBLIC_LUNORA_URL!,
    plugins: [expoClient({ scheme: "myapp", storage: SecureStore })],
});
```

```tsx
// lunora.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLunoraClient } from "@lunora/react-native";

// The bearer the client sends on HTTP and on every socket upgrade (set below).
let sessionBearer: string | null = null;
export const setSessionBearer = (token: string | null) => {
    sessionBearer = token;
};

export const client = createLunoraClient({
    url: process.env.EXPO_PUBLIC_LUNORA_URL!,
    storage: AsyncStorage,
    getAuthHeaders: () => (sessionBearer === null ? undefined : { authorization: `Bearer ${sessionBearer}` }),
});
```

Bridge the session into the client whenever it changes — `setAuthToken` for HTTP and
`setSessionBearer` for the socket's upgrade. The session is per user, so it never goes in
the `connect` frame: leave `LUNORA_WS_BEARER` unset for an Expo app, because a shipped app
cannot hold that shared secret.

```tsx
// App.tsx
import { useEffect } from "react";
import { expoBearerToken } from "@lunora/react-native/auth";

import { authClient } from "./auth";
import { client, setSessionBearer } from "./lunora";

function Root() {
    const { data: session } = authClient.useSession();

    // `expoBearerToken` is async since better-auth 1.7.1, and an async function
    // is not a valid effect cleanup return — so kick off a promise instead.
    // `cancelled` is load-bearing: two session changes in quick succession leave
    // two reads in flight, and without it the slower one reinstates the previous
    // session's token.
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            const token = await expoBearerToken(authClient);
            if (cancelled) return;
            setSessionBearer(token); // the socket upgrade's `Authorization: Bearer …`
            client.setAuthToken(token); // HTTP `Authorization: Bearer …`
        })();

        return () => {
            cancelled = true;
        };
    }, [session]);

    // …render the app
}
```

On the **server**, add better-auth's `expo()` and `bearer()` plugins. The socket upgrade
carries the same `Authorization` header, so `resolveIdentity` reads the headers as it does for HTTP (see
`@lunora/auth`):

```ts
import { bearer } from "@lunora/auth/plugins";
import { expo } from "@better-auth/expo";

// authOptions.plugins: [expo(), bearer(), /* … */]
// authOptions.trustedOrigins: ["myapp://"]

// createWorker({
//   resolveIdentity: async (request) => {
// const session = await auth.api.getSession({ headers: request.headers });
//     return session?.user?.id ? { userId: session.user.id } : null;
//   },
// });
```

### Why a bearer token

Lunora's runtime enables a CSRF Origin-check by default — it rejects any
state-changing HTTP request or WebSocket upgrade that carries a `Cookie` but no
trusted `Origin`. React Native sends no `Origin`, so a cookie-based credential is
**rejected** once signed in. A bearer token is the credential instead, and it
works on `react-native-web` for HTTP. A browser WebSocket cannot set the
upgrade's `Authorization` header, so the upgrade carries no bearer. Whether the socket
is identified then depends on the browser also sending a session cookie with it.

Using a bearer does **not** by itself guarantee the absence of a `Cookie` header.
React Native has a real cookie jar — `fetch` is backed by the platform HTTP stack
(`NSURLSession` / `OkHttp`) and its shared cookie store — so the `Set-Cookie` a
better-auth sign-in returns is kept and re-attached to later requests, and the
guard then 403s every state-changing RPC with `FORBIDDEN_ORIGIN`. It is
intermittent (it depends on whether the jar holds the cookie that launch), and
`security.csrf.trustedOrigins` cannot fix it: the trust list is only consulted
for an `Origin` that was actually received, and a missing one is rejected
outright. `createLunoraClient` closes this by sending `credentials: "omit"` on
every request; if you pass your own `fetch`, wrap it in `withoutAmbientCookies`.

### TanStack Query focus / online managers

React Native doesn't fire the browser's `focus` / `online` events, so Query
won't auto-refetch on app resume unless you point its managers at Expo's signals:

```ts
import { setupExpoFocusManager, setupExpoOnlineManager } from "@lunora/react-native/auth";

setupExpoFocusManager();
setupExpoOnlineManager();
```

## API

### `createLunoraClient(options)`

Everything on `LunoraClientOptions` (`url`, `wsUrl`, `authBasePath`,
`persistenceVersion`, …) plus:

| Option           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`        | React Native `AsyncStorage` (or any `getItem`/`setItem`/`removeItem` store). Wires `createAsyncStoragePersistence` for the offline queue.                                                                                                                                                                                                                                                                                                    |
| `getAuthHeaders` | `() => Record<string, string> \| undefined`. Generic escape hatch for a **custom** credential header (API-gateway key, proxy token) on every HTTP RPC + the WebSocket upgrade. For better-auth sessions prefer a bearer token: `expoBearerToken` with `setAuthToken` for HTTP, and this factory for the socket upgrade (the session credential's `setWsToken` covers the `connect` frame). A `Cookie` header here would trip the CSRF guard. |

An explicit `persistence`, `fetch`, or `WebSocket` always takes precedence over
the convenience derived from `storage` / `getAuthHeaders`.

### Re-exported `@lunora/react` surface

Every hook, provider, and auth gate from [`@lunora/react`](../react) is
re-exported here, wholesale — a new hook there lands on native with no edit to
this package.

The payment kit is **not** part of that surface: `CheckoutButton`,
`CustomerPortalButton`, and `useCheckout` render a DOM `<button>` and navigate
via `globalThis.location`, so they ship from the `@lunora/react/payment` subpath
rather than the `@lunora/react` root, and nothing re-exports them here. Drive
purchases through the platform's own flow (or a WebView pointed at the web
checkout URL).

`useVoiceAgent` is re-exported but its defaults are Web APIs (`getUserMedia`,
Web Audio, `WebSocket`): on native, pass your own `createMicrophone` /
`createSpeaker` implementations.

`useLiveTopic` is re-exported too, and it resolves the stream's route against the
`LunoraClient` from `<LunoraProvider>`, but it reads the global `fetch` and has no
per-call override. It needs a response body it can read as a stream, and stock
React Native `fetch` does not expose one: the subscription receives no events
and reports no error. Install a streaming `fetch` before the first live topic
mounts, e.g. `globalThis.fetch = fetch` from `expo/fetch` on Expo, or a
streaming polyfill elsewhere.

### `@lunora/react-native/auth`

- `expoBearerToken(authClient)` — reads the better-auth Expo session token (from
  `getCookie()`) for use with `client.setAuthToken` and `getAuthHeaders` (the socket upgrade); `null` when
  signed out.
- `expoClient`, `setupExpoFocusManager`, `setupExpoOnlineManager` — re-exported
  from `@better-auth/expo/client`.

## Example app

A complete Expo chat app (auth + live messages + offline queue) lives at
[`examples/expo`](../../examples/expo) in this repo.

## License

FSL-1.1-Apache-2.0 — see [LICENSE.md](./LICENSE.md).
