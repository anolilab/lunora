<div align="center">

# @lunora/react-native

**React Native / Expo integration for [Lunora](https://lunora.sh).**

</div>

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

React Native has no cookie jar, so Lunora needs the session attached to every
request. `@lunora/react-native/auth` wires the better-auth Expo plugin (session
persisted in `SecureStore`) and `expoAuthHeaders` bridges it into the client:

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
import { expoAuthHeaders } from "@lunora/react-native/auth";

import { authClient } from "./auth";

export const client = createLunoraClient({
    url: process.env.EXPO_PUBLIC_LUNORA_URL!,
    storage: AsyncStorage,
    getAuthHeaders: expoAuthHeaders(authClient), // Cookie header → HTTP RPC + WS upgrade
});
```

`getAuthHeaders` is read fresh on every request and every socket (re)connect, so
signing in/out takes effect on the next call without re-creating the client.

On the **server**, add better-auth's `expo()` plugin so your app scheme is a
trusted origin (see `@lunora/auth`):

```ts
import { expo } from "@lunora/auth/plugins";

// authOptions.plugins: [expo(), /* … */]
// authOptions.trustedOrigins: ["myapp://"]
```

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

| Option           | Description                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`        | React Native `AsyncStorage` (or any `getItem`/`setItem`/`removeItem` store). Wires `createAsyncStoragePersistence` for the offline queue.              |
| `getAuthHeaders` | `() => Record<string, string> \| undefined`. Headers attached to every HTTP RPC request and the WebSocket upgrade. Return `undefined` when signed out. |

An explicit `persistence`, `fetch`, or `WebSocket` always takes precedence over
the convenience derived from `storage` / `getAuthHeaders`.

### `@lunora/react-native/auth`

- `expoAuthHeaders(authClient)` — adapts a better-auth Expo client (its
  `getCookie()`) into the `getAuthHeaders` factory.
- `expoClient`, `setupExpoFocusManager`, `setupExpoOnlineManager` — re-exported
  from `@better-auth/expo/client`.

## Example app

A complete Expo chat app (auth + live messages + offline queue) lives at
[`apps/expo-example`](../../apps/expo-example) in this repo.

## License

FSL-1.1-Apache-2.0 — see [LICENSE.md](./LICENSE.md).
