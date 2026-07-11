# {{name}}

A React Native (Expo) chat app on Lunora — a live `useQuery` message list,
optimistic `useMutation` sends, AsyncStorage offline persistence, and
email/password auth via `@lunora/auth` + the better-auth Expo plugin. Runs on
**iOS, Android, and Web** from one codebase.

The project has two halves:

- **The client** — the Expo app (`App.tsx`, `src/`), built on `@lunora/react-native`.
- **The worker** — a Cloudflare Worker backend (`src/server/`, `lunora/`) with a
  `messages` table and `@lunora/auth`.

## Setup

Install dependencies with your package manager (`npm`, `pnpm`, `yarn`, or `bun`):

```bash
<pm> install
```

### 1. Configure the worker backend

Create a D1 database for the better-auth identity/session tables and paste the
printed id into `wrangler.jsonc` (`d1_databases[0].database_id`, replacing
`REPLACE_WITH_D1_ID`):

```bash
npx wrangler d1 create {{name}}
```

Add a local auth secret:

```bash
cp .dev.vars.example .dev.vars
# then set AUTH_SECRET — e.g. `openssl rand -hex 32`
```

Generate the Lunora types and start the worker (defaults to
<http://localhost:8787>):

```bash
<pm> run codegen
<pm> run dev:server
```

### 2. Start the app

In a second terminal:

```bash
<pm> run start      # then press i / a / w for iOS / Android / web
# or target one platform directly:
<pm> run ios
<pm> run android
<pm> run web
```

The app points at `http://localhost:8787` by default; override it with the
`EXPO_PUBLIC_LUNORA_URL` env var (e.g. your machine's LAN IP when running on a
physical device, or the deployed worker URL).

## Deploy the worker

```bash
<pm> run deploy
# and set the production secret:
npx wrangler secret put AUTH_SECRET
```

Point the app at the deployed worker via `EXPO_PUBLIC_LUNORA_URL`, and set
`AUTH_URL` (in `wrangler.jsonc` `vars`) to the same URL so better-auth resolves
cookie origins correctly.

## Running on web

The app bundles for the browser via `react-native-web`, and the live chat works
the same. Two web-specific notes:

- **Auth storage:** `expo-secure-store` has no web build, so `src/auth-client.ts`
  falls back to `localStorage` on web.
- **Socket auth:** the native client authenticates the WebSocket with an explicit
  `Cookie` header (React Native has no cookie jar); browsers ignore custom
  WebSocket headers and block a manual `Cookie`, so on web the socket relies on
  the browser's own cookie jar — which requires the worker to be **same-origin**
  with the web app (e.g. behind a shared domain/proxy in production).

## Renaming the app scheme

The URL scheme is `lunorachat` in three places that must stay in sync when you
rename it: `app.json` (`expo.scheme`), `src/auth-client.ts` (`APP_SCHEME`), and
`lunora/auth.ts` (`APP_SCHEME`, the server's trusted origin).
