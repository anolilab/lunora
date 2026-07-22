# notify-demo

End-to-end [`@lunora/notify`](../../packages/notify) push wiring — the smallest
real app that declares `lunora/notify.ts`, registers a device from the browser,
and broadcasts to it from an action.

## What it shows

- **`lunora/notify.ts`** — `defineNotify({ webPush, fcm, store })` with a
  D1-backed `d1SubscriptionStore(env.DB)`. Codegen discovers it and wires
  `ctx.notify` / `ctx.push` onto every handler ctx.
- **`lunora/push.ts`** —
    - `registerDevice` (mutation) → `ctx.push.register(...)`
    - `announce` (mutation) → records the announcement row
    - `broadcast` (action) → `ctx.notify.send(...)` (targeted) + `ctx.push.broadcast(...)` (fan-out)
- **Browser** — `subscribeToPush` from `@lunora/notify/web` registers `/sw.js`
  and returns a subscription the `registerDevice` mutation persists.
- **Studio** — registered devices (endpoint / kind / last-send status / delivery
  errors) surface on the Notifications page via the gated
  `__lunora_admin__:listPushSubscriptions` admin RPC, wired onto the worker's
  `notifySubscriptionStore` in `src/server/index.ts`.

## Run

```bash
pnpm --filter "@lunora-example/notify-demo" run codegen   # generate _generated/*
pnpm --filter "@lunora-example/notify-demo" run dev
```

Generate a VAPID keypair (`npx web-push generate-vapid-keys`), set
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` in `.dev.vars`, and the
matching `VITE_VAPID_PUBLIC_KEY` for the client.
