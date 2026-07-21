# Plan 165 — `@lunora/push` (push notifications)

- **Category**: feat (competitive parity — gap #7 in `plans/README.md` Wave 14)
- **Priority**: P2
- **Effort**: M · **Risk**: MED
- **Status**: TODO
- **Baseline**: `70331e9b` (2026-07-21)
- **Goal**: ship a first-class notification package (`ctx.notify` / `ctx.push`) —
  Web Push + FCM first — closing a table-stakes consumer/mobile gap vs Firebase
  Cloud Messaging, by **wrapping `@visulima/notification`** rather than building
  a push engine from scratch.

> **Reuse (visulima) — reframes this plan.** `@visulima/notification` already
> ships the engine: channels for **Push (FCM, Expo, Web Push, APNs)**, SMS, Chat
> (Slack/Discord/Teams/Telegram), In-app inbox, generic Webhook, and Email (via
> `@visulima/email`, already used by `@lunora/mail`). Crucially, **"nearly every
> provider is `fetch` + Web Crypto only and runs on Cloudflare Workers"** — Web
> Push + FCM are edge-safe. It brings routing (failover/broadcast), middleware
> (retry, rate-limit, circuit-breaker), queues, and preferences/opt-outs. So this
> plan becomes a **thin `ctx.notify` adapter + subscription storage + Studio
> surface**, not a from-scratch build — effort drops L → M, and scope expands from
> push-only to multi-channel for near-free. It also delivers the **outbound-webhook
> sliver** that plan 132 tracks, and the **in-app inbox** that was a non-goal.

## Context (verified)

Grep for `web-?push|fcm|apns|push.?notification|VAPID` over `packages/*/src`
returns **zero** hits. Lunora has no notification story at all. Firebase FCM (+
web push) is a default expectation for consumer and mobile apps.

Fits the existing binding-facade pattern (`@lunora/bindings` → `ctx.*`) and reuses
Cloudflare primitives: a DO/D1 for subscription storage, `@lunora/scheduler` for
scheduled sends, `@lunora/queue` for fan-out, `@lunora/studio` for a surface.

## Phase 0 — Edge-safety spike

- [x] Confirm `@visulima/notification`'s Web Push + FCM providers run under
      `workerd` (`fetch` + Web Crypto). **Caveat (like SAML):** APNs uses Node's
      `http2` and the BullMQ/pg-boss/SQS queue adapters are Node-only — scope APNs + heavy queueing out of the edge path or route them via `@lunora/queue`.

> **Spike result (verified 2026-07-21, `@visulima/notification@1.0.5`).** Both
> edge providers are confirmed edge-safe from their published typings/docs:
>
> - `@visulima/notification/providers/web-push` — _"Fully edge-safe — JWT signing
>   and payload encryption run on Web Crypto (ECDSA/ECDH P-256, HKDF, AES-GCM); no
>   `node:*`."_ (VAPID + RFC 8291 `aes128gcm`.)
> - `@visulima/notification/providers/fcm` — _"Edge-safe — you supply the OAuth2
>   token (static or via `getAccessToken`), so no `node:crypto`/Google SDK is
>   bundled."_ (FCM HTTP v1.)
> - The reused resilience middleware (`retryMiddleware`, `circuitBreakerMiddleware`,
>   `dedupeMiddleware`, `suppressionMiddleware`) is pure logic, no `node:*`.
>
> **Scoped OUT of the edge facade** (Node-only, matching the caveat): the APNs
> provider (`node:http2`) and the BullMQ/pg-boss/SQS queue adapters. `@lunora/notify`
> does **not** import `@visulima/notification/providers/apns` or any
> `@visulima/notification/queue/*` adapter; heavy fan-out is routed through
> `@lunora/queue` via `enqueuePushBroadcast` / `runPushBroadcastJob`. SMS providers
> are `fetch`-based (edge-capable) but are likewise not wired into the v1 facade
> (push-first scope). `@lunora/notify` builds + runs under the `runtime: "node"`
> packem target and depends only on the edge-safe subpaths.

## Phase 1 — Web Push + FCM via `ctx.notify`

- [x] New package `packages/notify` (`@lunora/notify`, alias `ctx.push`), ESM-only.
- [x] Wire `@visulima/notification` (Web Push + FCM channels); VAPID/FCM config via
      `@lunora/config` + `.dev.vars` grammar. (`webPushFromEnv` / `fcmFromEnv`;
      `@lunora/config` package-secrets registry entry scaffolds `VAPID_*` / `FCM_*`.)
- [x] Device/subscription storage (endpoint + keys) — `SubscriptionStore` interface
      with an in-memory default and a D1-backed store (`d1SubscriptionStore`, lazy
      `CREATE TABLE IF NOT EXISTS`).
- [~] Typed `ctx.notify.send(...)` / `ctx.push.broadcast(...)` facades **built** by
  `createNotify` (fully typed + tested); the codegen ctx auto-splice that makes
  them reachable as `ctx.*` in an app is the remaining wiring (see below), so
  end-to-end in a real worker is not yet demonstrable. `@lunora/notify/web`
  `subscribeToPush` service-worker helper shipped.

## Phase 2 — Additional channels (near-free from the engine)

- [x] Expose the engine's Chat / In-app inbox / Webhook channels through
      `ctx.notify` (`ctx.notify.chat/inApp/webhook`). SMS + APNs kept behind the
      Phase-0 edge-safety scoping (not wired into the v1 facade).

## Phase 3 — Surface & safety

- [ ] Studio page: registered devices, last-send status, delivery errors, inbox. **(open — remaining wiring)**
- [x] Advisor lints — `notify_send_outside_action` + `notify_missing_push_config`
      (evidence-gated, registered in `STATIC_LINTS`, tested). The codegen feeder
      that populates `context.notifyCalls` / `context.notifyConfig` is the remaining wiring.
- [x] Queue-backed fan-out via `@lunora/queue` (`enqueuePushBroadcast` /
      `runPushBroadcastJob`); the engine's retry/backoff + circuit-breaker middleware
      are attached in `buildEngine`.

## Remaining wiring (follow-ons)

- Codegen ctx-splice: a `discover-notify` feeder + `emit` wiring so `ctx.notify` /
  `ctx.push` are auto-spliced onto handler ctx from `lunora/notify.ts` (mirrors
  `discover-flags` → `ctx.flags`). `createNotify` is the factory it will call.
- Codegen advisor feeder to populate `context.notifyCalls` / `context.notifyConfig`.
- Studio "Notifications" page (devices, last-send status, delivery errors, inbox).
- Example app + docs site page.

## Exit criteria

- [ ] Web Push + FCM send/receive works end-to-end (workerd + a browser) via the
      `@visulima/notification` engine.
- [ ] Subscription lifecycle (register, expire, prune) handled and tested.
- [ ] APNs/SMS either edge-verified or explicitly scoped to a Node/queue path.
- [ ] Docs + example.

## Non-goals

- Rebuilding a notification engine — adapt `@visulima/notification`, don't rebuild.
- Rich campaign/marketing tooling in v1 (keep `ctx.notify` a primitive).
