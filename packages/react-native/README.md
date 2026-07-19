<div align="center">

# @lunora/react-native

**React Native / Expo integration for [Lunora](https://lunora.sh).**

</div>

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

---

The same live hooks you use on the web — `useQuery`, `useMutation`,
`useSubscription`, `useAuth`, `usePresence`, … — running on your phone, plus the
two seams a native app needs that a browser gives you for free: a durable offline
queue backed by `AsyncStorage`, and credentialed requests (there is no cookie jar
in React Native, so the session has to be attached explicitly).

This package **re-exports the entire `@lunora/react` surface**, so you import
your hooks and provider from here, and adds:

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

React Native has no cookie jar, so the session is sent as a **bearer** token: the
HTTP RPC carries it in the `Authorization` header and the live socket carries it
in the `?token=` query param. A bearer avoids the `Cookie` header the runtime's
CSRF guard rejects on an `Origin`-less native request (see [Why a bearer token](#why-a-bearer-token)).

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

export const client = createLunoraClient({
    url: process.env.EXPO_PUBLIC_LUNORA_URL!,
    storage: AsyncStorage,
});
```

Bridge the session into the client whenever it changes — `setAuthToken` for HTTP,
`setWsToken` for the socket:

```tsx
// App.tsx
import { useEffect } from "react";
import { expoBearerToken } from "@lunora/react-native/auth";

import { authClient } from "./auth";
import { client } from "./lunora";

function Root() {
    const { data: session } = authClient.useSession();

    useEffect(() => {
        const token = expoBearerToken(authClient);
        client.setAuthToken(token); // HTTP `Authorization: Bearer …`
        client.setWsToken(token ?? undefined); // WS `?token=…`
    }, [session]);

    // …render the app
}
```

On the **server**, add better-auth's `expo()` and `bearer()` plugins, and fold
the socket's `?token=` into an `Authorization` header in `resolveIdentity` (see
`@lunora/auth`):

```ts
import { bearer } from "@lunora/auth/plugins";
import { expo } from "@better-auth/expo";

// authOptions.plugins: [expo(), bearer(), /* … */]
// authOptions.trustedOrigins: ["myapp://"]

// createWorker({
//   resolveIdentity: async (request) => {
//     const headers = new Headers(request.headers);
//     const wsToken = new URL(request.url).searchParams.get("token");
//     if (wsToken && !headers.has("authorization")) headers.set("authorization", `Bearer ${wsToken}`);
//     const session = await auth.api.getSession({ headers });
//     return session?.user?.id ? { userId: session.user.id } : null;
//   },
// });
```

### Why a bearer token

Lunora's runtime enables a CSRF Origin-check by default — it rejects any
state-changing HTTP request or WebSocket upgrade that carries a `Cookie` but no
trusted `Origin`. React Native sends no `Origin`, so a cookie-based credential
would be **rejected** once signed in. A bearer token carries no `Cookie`, so it's
exempt — and it works identically on `react-native-web` (the browser lets you set
`Authorization`, and the token rides `?token=` on the socket).

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

| Option           | Description                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`        | React Native `AsyncStorage` (or any `getItem`/`setItem`/`removeItem` store). Wires `createAsyncStoragePersistence` for the offline queue.                                                                                                                                                                                           |
| `getAuthHeaders` | `() => Record<string, string> \| undefined`. Generic escape hatch for a **custom** credential header (API-gateway key, proxy token) on every HTTP RPC + the WebSocket upgrade. For better-auth sessions prefer a bearer token (`expoBearerToken` + `setAuthToken`/`setWsToken`) — a `Cookie` header here would trip the CSRF guard. |

An explicit `persistence`, `fetch`, or `WebSocket` always takes precedence over
the convenience derived from `storage` / `getAuthHeaders`.

### `@lunora/react-native/auth`

- `expoBearerToken(authClient)` — reads the better-auth Expo session token (from
  `getCookie()`) for use with `client.setAuthToken` / `setWsToken`; `null` when
  signed out.
- `expoClient`, `setupExpoFocusManager`, `setupExpoOnlineManager` — re-exported
  from `@better-auth/expo/client`.

## Example app

A complete Expo chat app (auth + live messages + offline queue) lives at
[`examples/expo`](../../examples/expo) in this repo.

## License

FSL-1.1-Apache-2.0 — see [LICENSE.md](./LICENSE.md).
