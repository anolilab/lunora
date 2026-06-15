# Plan 029: Email Routing / Email Workers (INBOUND)

> **Executor instructions**: Follow step by step. Run every verification command and confirm before moving on. On a "STOP conditions" item, stop and report. When done, tick checkboxes and update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 058071c8..HEAD -- packages/mail/src packages/runtime/src/create-worker.ts packages/config/src/wrangler-validator.ts`. If `packages/mail/src/cloudflare-transport.ts`, `packages/mail/src/create-mailer.ts`, `packages/mail/src/queue.ts`, or `packages/runtime/src/create-worker.ts` have diverged from the line references in "Current state" below, STOP and re-read before continuing.

## Status

- **Priority**: P2 — inbound completes the mail story (`@cirrus/mail` is outbound-only today), but no consumer is blocked on it; outbound + the dev catcher cover the common case. Lands cleanly as an additive `@cirrus/mail/inbound` subpath.
- **Effort**: M
- **Risk**: MEDIUM — the `email()` worker entrypoint and `cloudflare:email`/`ForwardableEmailMessage` types can only be exercised under workerd, so the core parse/dispatch logic must be unit-testable in plain Node (see STOP conditions). MIME parsing is the main correctness surface.
- **Depends on**: none (additive). Pairs naturally with the existing outbound transport in `packages/mail/src/cloudflare-transport.ts`.
- **Category**: feature (new Cloudflare capability — Email Workers inbound)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

Extend `@cirrus/mail` with a new `@cirrus/mail/inbound` subpath rather than a new package — it shares the address/header-safety helpers (`packages/mail/src/address.ts`), mirrors the existing outbound `cloudflareSend` callback-injection pattern (`packages/mail/src/cloudflare-transport.ts:7-27`) that keeps the package free of a `cloudflare:email` import, and the mail domain is already where developers look. Inbound mail arrives via a Worker's exported `email(message, env, ctx)` handler receiving a `ForwardableEmailMessage`; the plan is a runtime-agnostic `createInboundEmailHandler({ parse, dispatch })` factory whose `dispatch` forwards a parsed message into a Cirrus mutation/action over the same `/_cirrus/rpc` shard path the dev capture sink already uses (`packages/mail/src/from-env.ts:26-40`). The worker-entry composition stays in the host/codegen-generated entry (where `cloudflare:email` and the shard namespace are reachable), exactly like the outbound `send` callback is injected by the scaffold today.

## Current state

- `@cirrus/mail` is **outbound only**. `packages/mail/src/index.ts:1-13` exports `createMailer`, the Resend + Cloudflare transports, the queue helpers, and render — no inbound surface anywhere.
- The outbound Cloudflare transport already models the "Workers runtime owns the binding, inject a thin callback" pattern: `packages/mail/src/cloudflare-transport.ts:7-27` documents wiring `send: async (from, to, raw) => { const { EmailMessage } = await import("cloudflare:email"); await env.SEND_EMAIL.send(...) }`, keeping the package free of a `cloudflare:email` import and unit-testable. Inbound must mirror this: the host injects the `cloudflare:email` reply/forward callbacks; the package stays import-free.
- The dev capture sink shows the canonical "dispatch into a Cirrus function via an admin RPC over the shard stub" path: `packages/mail/src/from-env.ts:25-40` posts a reserved `__cirrus_admin__:recordMail` op to the root shard stub. Inbound dispatch reuses the same shape — a structural `ShardStubLike`/`ShardNamespaceLike` (`from-env.ts:34-40`) — to route a parsed message into a user-named mutation/action.
- Address/header CR-LF safety helpers already exist and must be reused for any parsed-header echo: `packages/mail/src/create-mailer.ts:50-71` calls `assertSafeHeaderValue` / `assertSafeAddresses` from `packages/mail/src/address.ts`.
- The runtime worker entry (`packages/runtime/src/create-worker.ts:1153` `createWorker`) returns `{ fetch, scheduled, serverQuery }` (`CirrusWorker`, lines 1121-1147) — there is **no `email` entrypoint**. Cloudflare's `email(message, env, ctx)` is a sibling top-level export of `fetch`/`scheduled`; the generated host entry (e.g. `apps/playground/src/server/index.ts:1-12`, which `export default createWorker(...)`) is where it must be attached. `createWorker` already exposes the shard namespace + `resolveForwardContext` it would need to dispatch.
- `RpcEnvelope` (`packages/runtime/src/create-worker.ts:32-37`) is the wire shape inbound dispatch targets: `{ functionPath, args, shardKey? }` posted to `/_cirrus/rpc`. The inbound handler builds one of these from the parsed message and a developer-supplied `functionPath`.
- **Config/wrangler**: `packages/config/src/wrangler-validator.ts` validates `durable_objects`, `migrations`, `tail_consumers` — there is **no email-routing config awareness**. Email Routing rules (which addresses route to the worker) are configured in the Cloudflare dashboard / `wrangler.jsonc` `send_email` + email routing, not codegen-managed. This plan does **not** auto-manage routing rules; it documents the required `wrangler.jsonc`/dashboard config and (Item 4) adds a light validator note so the studio/CLI can surface "no inbound route configured".

## Item breakdown

Each item is its own PR.

- [x] **Item 1: `parseInboundEmail()` — runtime-agnostic MIME parser.** New `packages/mail/src/inbound/parse.ts`. Input: a `ReadableStream`/`ArrayBuffer`/`string` of the raw RFC 822 message (the host reads `message.raw` off the `ForwardableEmailMessage` and passes bytes — package never imports `cloudflare:email`). Output: a typed `InboundEmail` `{ from, to, subject, messageId, inReplyTo?, references?, headers, text?, html?, attachments: InboundAttachment[] }`. Use a dependency-light MIME parser added to `pnpm-workspace.yaml` catalog (e.g. `postal-mime`, which is workerd-compatible and pure-JS) referenced as `catalog:dev`/runtime — do **not** hardcode the version. Reuse `assertSafeHeaderValue` from `packages/mail/src/address.ts` when surfacing parsed header values so a crafted inbound header can't smuggle CR/LF downstream. Named exports only. Test (plain Node): feed fixture `.eml` strings (multipart/alternative, with-attachment, threaded reply with `In-Reply-To`) and assert the parsed shape — no workerd needed.
- [x] **Item 2: `createInboundEmailHandler({ parse, dispatch, onError? })` factory + shard dispatcher.** New `packages/mail/src/inbound/handler.ts`. The factory returns an `async (message, env, ctx)`-shaped callback typed against a **structural** `ForwardableEmailMessageLike` (`{ from, to, raw: ReadableStream, headers: Headers, setReject, forward, reply }`) so the package needs no `cloudflare:email` import — mirroring `CloudflareSend` (`packages/mail/src/cloudflare-transport.ts:20`). It (a) reads `message.raw`, (b) calls `parseInboundEmail`, (c) calls `dispatch(parsed, { message, env, ctx })`. Provide a built-in `dispatch` builder `dispatchToCirrusFunction({ shard, functionPath, shardKey?, resolveArgs? })` that posts an `RpcEnvelope` (`{ functionPath, args, shardKey }`) to the root shard stub via the structural `ShardNamespaceLike`/`ShardStubLike` already defined in `packages/mail/src/from-env.ts:34-40` (extract those two interfaces into a shared `packages/mail/src/inbound/shard.ts` or re-import). On dispatch failure call `message.setReject(reason)` (so Cloudflare bounces / retries) via `onError`. Named exports only. Test (plain Node): a fake `ForwardableEmailMessageLike` + a stub shard namespace; assert the posted envelope's `functionPath`/`args`/`shardKey` and that a thrown dispatch triggers `setReject`.
- [x] **Item 3: `packages/mail/src/inbound/index.ts` barrel + `./inbound` subpath export.** Re-export `parseInboundEmail`, `createInboundEmailHandler`, `dispatchToCirrusFunction`, and the `InboundEmail`/`InboundAttachment`/`ForwardableEmailMessageLike` types. Add the `./inbound` conditional export to `packages/mail/package.json` mirroring the existing `./testing` block (`packages/mail/package.json:45-48`), add the build entry to `packem.config.ts`, and add `"./inbound"` to `files` coverage via `dist`. Keep the root `packages/mail/src/index.ts` unchanged (no mixed surfaces). Verify the subpath resolves: `pnpm --filter "@cirrus/mail" run build` then a tiny import smoke test.
- [x] **Item 4: host-entry wiring example + `email()` composition guide + wrangler note.** Add a documented wiring snippet to `apps/playground/src/server/index.ts` (or a new `docs/addons/mail.mdx` "Receiving email" section) showing the generated entry exporting `email` alongside `default`:
    ```ts
    import { createInboundEmailHandler, parseInboundEmail, dispatchToCirrusFunction } from "@cirrus/mail/inbound";
    export const email = createInboundEmailHandler({
        parse: parseInboundEmail,
        dispatch: dispatchToCirrusFunction({ shard: env.SHARD, functionPath: "inbound:onEmail", shardKey: "__root__" }),
    });
    ```
    Document the required `wrangler.jsonc` (`send_email` binding for any auto-reply/forward, plus the Email Routing rule that routes an address to this Worker — dashboard-configured) in the same doc. Add a small advisory check to `packages/config/src/wrangler-validator.ts` (non-failing, surfaced like the existing `tail_consumers` shape note at lines 295-339): if a host exports `email` (signalled by a flag the codegen entry sets, or skip if not inferrable) warn when no inbound routing is documented. Keep this strictly additive — do not block validation. Test: extend the wrangler-validator test with the new note path; assert it never turns a valid config invalid.

## Verification

```bash
pnpm --filter "@cirrus/mail" run build
pnpm --filter "@cirrus/mail" run test            # parse + handler unit tests (plain Node)
pnpm --filter "@cirrus/mail" run lint:types
pnpm --filter "@cirrus/config" run test          # wrangler-validator note (Item 4)
pnpm --filter "@cirrus/config" run lint:types
pnpm run lint:eslint:fix
```

Run `pnpm run build:packages` once first if `@cirrus/mail`'s `dist` is stale (cross-package type resolution needs built deps — see CLAUDE.md note).

## STOP conditions

- If `ForwardableEmailMessage`'s real runtime shape (method names `setReject`/`forward`/`reply`, `raw` as `ReadableStream`) differs from the structural `ForwardableEmailMessageLike` you wrote — confirm against `@cloudflare/workers-types` before finalizing Item 2; STOP and adjust the structural type rather than guessing.
- workerd cannot run in this sandbox: do **not** attempt an integration test that imports `cloudflare:email` or drives a real `email()` entrypoint. If a test needs workerd, mark it CI-only (`describe.skip` with a `// CI-only: workerd` note) and keep the parse/dispatch logic covered by plain-Node unit tests. If you cannot achieve meaningful coverage without workerd, STOP and report.
- If adding the MIME parser dependency would pull in a Node-only (non-workerd-compatible) package, STOP — pick a pure-JS/workerd-safe parser (e.g. `postal-mime`) and record the choice in the catalog.
- If `packages/mail/src/from-env.ts`'s `ShardNamespaceLike`/`ShardStubLike` have changed shape since the line references above, STOP and reconcile before reusing them in Item 2.
