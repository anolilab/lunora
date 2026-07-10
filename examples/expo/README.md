# Lunora Expo Example

A complete **Expo (React Native)** chat app on Lunora — email/password auth, a
live message list, optimistic + offline-safe sends — built on
[`@lunora/react-native`](../../packages/react-native).

It's one folder with two halves:

- **Backend** (`lunora/`, `src/server/`, `wrangler.jsonc`) — a Cloudflare Worker:
  a `messages` table in a Durable Object plus `@lunora/auth` (better-auth) with
  the Expo plugin.
- **Mobile client** (`App.tsx`, `src/`) — the Expo app that talks to it.

## What it shows

- `createLunoraClient` with `AsyncStorage` persistence — sends made offline are
  queued and flush on reconnect.
- better-auth over Expo `SecureStore`, bridged into the Lunora client with
  `expoAuthHeaders` so the live socket and RPC run as the signed-in user.
- `useQuery` (live subscription), `useMutation` (optimistic), and
  `useConnectionStatus` (the live/offline badge) from `@lunora/react-native`.

## Run it

### 1. Backend (Cloudflare Worker)

```sh
# from this folder
cp .dev.vars.example .dev.vars          # then set AUTH_SECRET (openssl rand -hex 32)
pnpm wrangler d1 create lunora-expo-example   # paste the id into wrangler.jsonc
pnpm codegen                            # regenerate lunora/_generated
pnpm dev:server                         # wrangler dev → http://localhost:8787
```

### 2. Mobile client (Expo)

Point the app at the worker, then start Expo:

```sh
# a device/simulator can't reach "localhost" — use your machine's LAN IP,
# or a tunnel (e.g. `pnpm wrangler dev --ip 0.0.0.0` + your IP).
export EXPO_PUBLIC_LUNORA_URL="http://<your-lan-ip>:8787"
pnpm start                              # then press i / a, or scan the QR
```

Sign up, and you're in the chat. Open a second device (or the web target,
`pnpm web`) to watch messages sync live.

> **Auth over a native scheme.** `app.json` sets `scheme: "expoexample"`, which
> `src/auth-client.ts` passes to the Expo plugin and `lunora/auth.ts` lists as a
> trusted origin on the server. Keep the three in sync if you rename it.

## Layout

| Path                  | What                                                          |
| --------------------- | ------------------------------------------------------------- |
| `lunora/schema.ts`    | The `messages` table.                                         |
| `lunora/messages.ts`  | `list` query (live) + `send` mutation (auth-gated).           |
| `lunora/auth.ts`      | better-auth config (email/password + Expo plugin).            |
| `src/server/index.ts` | Worker entry: auth routing + `resolveIdentity` + the ShardDO. |
| `src/auth-client.ts`  | better-auth Expo client (SecureStore).                        |
| `src/lunora.ts`       | `createLunoraClient` (AsyncStorage + `expoAuthHeaders`).      |
| `App.tsx`             | Providers + the session gate (Login ↔ Chat).                  |
| `src/Login.tsx`       | Email/password sign-in / sign-up.                             |
| `src/Chat.tsx`        | Live message list + composer.                                 |

## Deploy

```sh
pnpm wrangler secret put AUTH_SECRET
pnpm deploy                             # wrangler deploy
```

Set `AUTH_URL` in `wrangler.jsonc` (and `EXPO_PUBLIC_LUNORA_URL` in the app) to
the deployed worker URL.
