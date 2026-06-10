# @cirrus/ssr

The framework-neutral server contract that every Cirrus meta-framework adapter (React, Solid, Svelte, Vue) depends on. It owns the server-side seam of an SSR loader: a request-scoped HTTP RPC client, session resolution from the inbound request, query preloading, and the dehydrate helpers for handing a preloaded snapshot to the client. Nothing here opens a WebSocket or touches a UI framework, so it is safe to import from any SSR loader.

## Install

```bash
pnpm add @cirrus/ssr
```

## API

- `createServerClient({ url, token?, fetch? })` — request-scoped HTTP RPC client (no WS), safe in any SSR loader. Pass `token` (e.g. from `getServerSession`) to run the load as the signed-in user.
- `getServerSession(request, auth)` — resolve `{ user, session } | null` from the inbound request headers + a better-auth instance. The `auth` parameter is structurally typed, so this package carries no hard dependency on `@cirrus/auth`; pass a real `@cirrus/auth` instance to keep full inference.
- `preloadQuery(client, fn, args, { shardKey? })` → `Preloaded<T>` — run a query once on the server and capture a serializable snapshot (re-exported from `@cirrus/client`).
- `serializePreloaded(preloaded)` / `deserializePreloaded(serialized)` — embed a `Preloaded` token in HTML safely and read it back on the client.

## Usage

```ts
import { createServerClient, getServerSession, preloadQuery, serializePreloaded } from "@cirrus/ssr";

export async function loader({ request }: { request: Request }) {
    const session = await getServerSession(request, auth);
    const client = createServerClient({ url: CIRRUS_URL, token: session?.session.token });
    const preloaded = await preloadQuery(client, api.messages.list, { roomId });

    return { preloaded: serializePreloaded(preloaded) };
}
```
