# Plan 011: Mail catcher — capture transactional email in dev and view it in the studio (+ Playwright auth helper)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 92f719ab..HEAD -- packages/mail packages/do/src/shard-do.ts packages/studio/src packages/studio/src/admin.ts registry/mail`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (pairs with plan 012, which can offer to enable this; not a hard dep)
- **Category**: dx
- **Planned at**: commit `92f719ab`, 2026-06-12

## Why this matters

Cirrus's pitch is the dev loop. Today, the moment a developer wires up
`@cirrus/auth` + `@cirrus/mail`, the dev loop for anything email-shaped goes
dark: a sign-up verification link, a forgot-password reset link, or an app's
own transactional mail (receipt, invite) all go to **Resend** — which means in
dev you either need a live `RESEND_API_KEY` and a verified domain, or the send
throws and the flow is untestable. There is no way to _see_ what was sent.

Every competitor solves this with a local mail catcher (Mailpit / Mailhog /
Inbucket / the Convex/Supabase dev inbox). Cirrus already has the two pieces
needed to do it natively and better: a swappable `MailTransport` in
`@cirrus/mail`, and a studio with an admin-RPC introspection channel and a
panel framework. This plan adds:

1. A **capture transport** in `@cirrus/mail` that, in dev, persists every send
   to a single well-known mailbox instead of hitting a real provider — so
   `cirrus dev` "just works" with zero email config and nothing leaks
   externally.
2. A **Mail** panel in the studio: a two-pane inbox (list + sandboxed HTML/text
   preview) reading the captured mail over a new admin RPC.
3. A **Playwright/test helper** (`@cirrus/mail/testing`) so auth E2E can trigger
   forgot-password / email-verification, then read the captured mail and pull
   the link out — turning today's untestable flows into deterministic tests.

This directly answers the user's request: a dashboard mail catcher to see sent
mail (incl. auth's transactional mail), used by Playwright to drive
forgot-password and similar flows.

## Design decisions (already made — do not relitigate)

These four were chosen by the maintainer; build to them:

- **Capture mode = capture-only in dev.** The dev transport intercepts every
  send, persists it, and does **not** call a real provider. No real email leaves
  the machine in dev.
- **Default real provider = Cloudflare Email Workers.** The prod default
  transport is Cloudflare's `send_email` binding (via
  `@visulima/email/providers/cloudflare-email`), not Resend. The provider takes a
  thin `send(from, to, raw)` the scaffold wires to the binding
  (`new EmailMessage(from, to, raw)` from `cloudflare:email`). It is
  single-recipient and only delivers to **verified Email Routing destination
  addresses** — fine for app→user notifications once routing is set up, and
  irrelevant in dev because the capture transport intercepts first. Resend (and
  the other `@visulima/email` providers) remain available as an opt-in
  `transport` override.
- **Storage = one dedicated mailbox.** All captured mail lands in a single,
  well-known location so the studio shows one unified inbox regardless of which
  shard/function sent it. Model it on `packages/do/src/auth-metrics.ts`, which
  records app-wide signal against the **root shard** so a single read returns
  everything. Use a reserved `__cirrus_mail` table on the root shard.
- **Test access = test helper + admin RPC.** Ship a `waitForMail` /
  `extractLink` helper backed by the read admin RPC, not just the raw RPC.
- **Build on what exists.** Reuse the `MailTransport` seam, the
  `__cirrus_admin__:*` admin-RPC channel, the studio panel pattern, and the
  reserved-`__cirrus`-table convention. Do not invent a parallel transport or a
  second introspection channel.

## Current state

### `@cirrus/mail` — the transport seam

- `packages/mail/src/types.ts:17-19` defines the swap point:

```ts
export interface MailTransport {
    send: (payload: SendPayload) => Promise<{ id: string }>;
}
```

- `packages/mail/src/types.ts:46-55` — `CirrusMailOptions.transport?: MailTransport`
  already overrides the default Resend transport. `SendPayload`
  (`types.ts:21-31`) is the post-render, JSON-shaped value (`from`, `to`, `cc`,
  `bcc`, `subject`, `html`, `text`, `headers`) — exactly what we persist.
- `packages/mail/src/create-mailer.ts` builds the Resend transport and runs
  address/header CR-LF validation **before** `transport.send`, so a capture
  transport inherits the same safety for free.
- `packages/mail/src/index.ts` is the public barrel (5 exports today).
- The package is ESM-only, no `.js` extensions on relative imports (CLAUDE.md).

### The registry mail scaffold — where a user's mailer is built

- `registry/mail/mail.ts` constructs the mailer per-call from `env`:

```ts
const mailer = (): Mailer =>
    createMailer({
        apiKey: requireEnv("RESEND_API_KEY"),
        from: requireEnv("MAIL_FROM"),
        // queue: <your Queue binding>,
    });
```

This is the file copied into a user's project by `cirrus registry add mail`
(`merge: create-or-skip`, see `registry/mail/registry.json`). It is the
natural place to choose capture-vs-Resend by environment. Auth's
`sendResetPassword` / `sendVerificationEmail` callbacks (scaffolded in
`registry/auth/index.ts`, currently `emailAndPassword: { enabled: true }` with
no email callbacks yet) are expected to call into this same mailer, so
capturing at the mailer level catches auth mail too.

### `@cirrus/do` — reserved tables + admin RPC, the model to copy

- `packages/do/src/auth-metrics.ts` is the **template**: it defines reserved
  `__cirrus_auth_metrics*` tables, writes via the DO's `runSql` indirection,
  records against the **root shard** ("a single read gives the whole app's auth
  health"), and the `__cirrus` prefix auto-hides the tables from the data
  browser.
- The worker already records auth events into the root shard via a reserved
  **write** admin RPC: `shard-do.ts:734` documents
  `__cirrus_admin__:recordAuthEvent` ("the worker's … payload"). This is the
  precedent for a worker-side side-effect writing into the root shard over the
  admin channel — `recordMail` follows it exactly.
- Admin RPCs are dispatched in `ShardDO.handleAdminRpc`
  (`packages/do/src/shard-do.ts:2747`, branch examples at `:3138`
  `getAuthMetrics`). Each `__cirrus_admin__:*` path is gated by
  `CIRRUS_ADMIN_TOKEN` before user dispatch.

### The studio — panel + admin contract

- `packages/studio/src/admin.ts:20-45` — `ADMIN_FUNCTIONS` const maps studio
  call names to `__cirrus_admin__:*` paths (currently ~24 entries). Row shapes
  are duplicated here as plain types so the DO runtime never enters the studio
  bundle (see the file header).
- `packages/studio/src/studio.tsx` — navigation IA: a `StudioTab` union, a
  `TAB_ICONS` map, a `TABS` array, `NAV_GROUPS`, `tabLabel`/`tabDescription`
  maps, and a `panels: Record<StudioTab, ReactElement>` map in `buildRouter`.
  Adding a section means touching each of these (the realtime
  `subscriptions-panel.tsx` was added this exact way).
- Panel pattern: `useCirrus()` client + `adminRef(path)` + `callOptions(shard)`
    - `fireAndForget` + `errorMessage` (`packages/studio/src/internal.ts`), render
      with the vendored shadcn primitives in `packages/studio/src/components/ui/`.
- Vendored UI primitives present: `scroll-area`, `separator`, `badge`, `table`,
  `button`, `tooltip`, `card`, `dropdown-menu`, `empty-state`, `input`, `select`,
  `skeleton`, `popover`, `alert`, `checkbox`, `label`, `modal-shell`, `textarea`.
  **Missing** for a mail reader: `resizable`, `tabs`, `avatar`.
- i18n: every user-facing string must be added to the `MESSAGE_IDS` array in
  `packages/studio/src/locales/en.ts` (compile-time-checked by `useT()`).
- shadcn note (already researched): the official `@shadcn` registry has **no**
  "inbox"/"mail" block — search returns only `login-05`. The well-known shadcn
  "Mail" example is a demo composed from primitives, not an installable block.
  So compose the inbox from existing primitives + add `resizable`/`tabs` via
  `npx shadcn@latest add @shadcn/resizable @shadcn/tabs -c apps/studio`
  (style `base-lyra`, see `apps/studio/components.json`). Do **not** add a third
  registry or a heavyweight dependency.

## Commands you will need

| Purpose          | Command                                                               | Expected on success |
| ---------------- | --------------------------------------------------------------------- | ------------------- |
| Install          | `pnpm install`                                                        | exit 0              |
| Mail tests       | `pnpm --filter "@cirrus/mail" run test`                               | all pass            |
| DO tests         | `pnpm --filter "@cirrus/do" run test`                                 | all pass            |
| Studio tests     | `pnpm --filter "@cirrus/studio" run test`                             | all pass            |
| Typecheck (each) | `pnpm --filter "@cirrus/<pkg>" run lint:types`                        | exit 0              |
| Lint (each)      | `pnpm --filter "@cirrus/<pkg>" run lint:eslint`                       | exit 0              |
| Add shadcn prims | `npx shadcn@latest add @shadcn/resizable @shadcn/tabs -c apps/studio` | files written       |
| Build affected   | `pnpm run build:affected`                                             | exit 0              |

## Scope

**In scope** (the only files/areas you should modify):

- `packages/mail/src/` — new `capture-transport.ts`, a `CapturedMail` type, a
  new `testing.ts` entry (+ a `./testing` conditional export in
  `packages/mail/package.json`), barrel updates in `index.ts`.
- `packages/mail/__tests__/` — capture-transport + helper tests.
- `packages/do/src/` — a new `mail-catcher.ts` (reserved `__cirrus_mail` table,
  record + read), wired into `shard-do.ts`'s `handleAdminRpc` as two new
  `__cirrus_admin__:recordMail` (write) and `__cirrus_admin__:getCapturedMail`
  (read) paths. A small structural mailbox-sink helper the worker/transport uses
  to reach the root shard (mirror `recordAuthEvent`'s worker→root-shard path).
- `packages/do/__tests__/` — record/read + bounded-trim tests.
- `packages/studio/src/` — `admin.ts` (new paths + `CapturedMail` row type),
  new `mail-panel.tsx` (two-pane inbox), `studio.tsx` (register the `mail` tab),
  `locales/en.ts` (strings), `index.ts` (export the panel), and the two new
  vendored primitives under `components/ui/`.
- `packages/studio/__tests__/` — a `mail-panel.test.tsx`.
- `registry/mail/mail.ts` — choose capture-vs-Resend transport by env (the only
  scaffold change). Update `registry/mail/registry.json` docs string + a
  `CIRRUS_MAIL_CAPTURE`-style env var note if you add one.
- One example wiring: an `examples/auth-playground` Playwright spec that drives
  forgot-password through the capture helper (read the example first; only add a
  spec + minimal glue, do not restructure the example).

**Out of scope** (do NOT touch):

- The Resend transport and address/header validation in `create-mailer.ts`
  (capture reuses them; do not alter the validation path).
- The `queue()` path and `consumeQueuedSend` (a follow-up could capture queued
  mail too; not this plan).
- `packages/do/src/shard-do.ts` god-file refactor — add the two RPC branches and
  delegate the body to `mail-catcher.ts`; do **not** restructure the file.
- Production behavior: when capture is off, the mailer must behave exactly as
  today. No always-on interception in prod.
- Any other studio panel, the data browser, or the auth metrics tables.

## Git workflow

- Branch: `dx/studio-mail-catcher` off `alpha`.
- Conventional commits, one logical change each, e.g.:
    - `feat(mail): capture transport + testing helper for dev mail catcher`
    - `feat(do): persist captured mail on root shard + admin RPCs`
    - `feat(studio): mail catcher inbox panel`
    - `feat(mail): wire capture transport into the mail registry scaffold`
    - `test(auth-playground): forgot-password E2E via captured mail`
- Do not push or open a PR unless the user asks. Stop after the branch is ready
  and report.

## Steps

### Step 1 — Capture transport in `@cirrus/mail`

1. Add `packages/mail/src/capture-transport.ts`. Define a structural sink so the
   package stays DO-agnostic (mirror `QueueLike` in `types.ts`):

```ts
export interface CapturedMail extends SendPayload {
    /** Stable id assigned to the captured message. */
    id: string;
    /** Capture timestamp (ms since epoch). */
    capturedAt: number;
}

/** Minimal projection of the persistence target (the root-shard mailbox). */
export interface MailboxSink {
    record: (mail: SendPayload) => Promise<{ id: string }>;
}
```

Then `createCaptureTransport(sink: MailboxSink): MailTransport` whose `send`
calls `sink.record(payload)` and returns `{ id }`. Generating the id and
timestamp belongs to the sink (the DO), not the transport — keep the
transport pure and side-effect-only-through-the-sink so it is trivially
unit-testable with a fake sink.

2. Export `createCaptureTransport`, `CapturedMail`, `MailboxSink` from
   `packages/mail/src/index.ts`.

    **Verify**: `pnpm --filter "@cirrus/mail" run lint:types` exits 0.

### Step 2 — Persist captured mail in `@cirrus/do`

1. Add `packages/do/src/mail-catcher.ts`, modeled on `auth-metrics.ts`:
    - Reserved table `__cirrus_mail` (auto-hidden by the `__cirrus` prefix).
      Columns: `id TEXT PRIMARY KEY`, `captured_at REAL NOT NULL`, `from TEXT`,
      `to TEXT` (JSON array or string), `cc TEXT`, `bcc TEXT`, `subject TEXT`,
      `html TEXT`, `text TEXT`, `headers TEXT` (JSON). All via the existing
      `runSql`/`SqlExec` indirection used in `auth-metrics.ts`.
    - `recordCapturedMail(exec, payload)` → inserts a row, returns `{ id }`.
      Generate the id inside the DO. **Bound the table**: after insert, trim to
      the most recent N rows (e.g. 500), exactly like
      `__cirrus_metrics_buckets`/`auth-metrics` trim.
    - `readCapturedMail(cursor, { limit, after })` → newest-first page for the
      studio.
2. Wire two branches into `ShardDO.handleAdminRpc` (`shard-do.ts:2747`),
   alongside the existing `getAuthMetrics`/`recordAuthEvent` branches:
    - `__cirrus_admin__:recordMail` (write) → validate payload (reuse the
      existing validate-args idiom near `shard-do.ts:609-734`), call
      `recordCapturedMail`. **This RPC must be a no-op unless capture is active**
      — gate it so a production worker that never enables capture cannot have mail
      injected (e.g. require the same `CIRRUS_ADMIN_TOKEN` the channel already
      enforces, and only the dev path ever calls it).
    - `__cirrus_admin__:getCapturedMail` (read) → `readCapturedMail`.
3. Provide the worker→root-shard sink. The capture transport runs in the Worker
   (action context), not inside the DO, so it needs to reach the root shard the
   same way the worker records auth events. Add a small helper (export from
   `@cirrus/do`, structural namespace type — do not leak concrete bindings) that
   returns a `MailboxSink` calling `__cirrus_admin__:recordMail` on the root
   shard stub. Name the root id consistently with how auth-metrics resolves the
   root shard (read `auth-metrics.ts` + its caller to copy the exact root-id
   convention — do **not** invent a new one).

    **Verify**: `pnpm --filter "@cirrus/do" run test` passes incl. new
    record/read/trim tests; `lint:types` exits 0.

### Step 3 — Studio Mail panel

1. `packages/studio/src/admin.ts`: add `getCapturedMail` (and, if the studio
   needs to clear the inbox, an optional `clearCapturedMail`) to
   `ADMIN_FUNCTIONS`, plus a `CapturedMail` row type mirroring the DO shape
   (plain type — no runtime import from `@cirrus/do`).
2. Add the two missing primitives:
   `npx shadcn@latest add @shadcn/resizable @shadcn/tabs -c apps/studio`
   (avatar is optional — only if you show a sender avatar; prefer initials in a
   `badge` to avoid the extra primitive).
3. Add `packages/studio/src/mail-panel.tsx` — a two-pane reader:
    - Left: a list (reuse `table` or a `scroll-area` list) of captured messages
      (to, subject, captured-at), newest first, selectable.
    - Right: the selected message. **Render HTML in a sandboxed iframe**
      (`sandbox` with no `allow-scripts`; set `srcdoc`) so captured HTML cannot
      run script in the studio. A `tabs` switch for HTML / Plain text / Headers.
    - `EmptyState` when no mail; `errorMessage`/alert on RPC failure; a Refresh
      button (and optional auto-refresh via the existing `use-auto-refresh`
      hook). Follow `subscriptions-panel.tsx` for the load/refresh/error shape.
    - This is a single-inbox view (no shard picker) — the mailbox is the root
      shard. Do not add a `ShardInput`.
4. Register the tab in `studio.tsx`: add `"mail"` to `StudioTab`, an envelope
   glyph to `TAB_ICONS`, the entry in `TABS`, a sensible `NAV_GROUPS` placement
   (group with Logs/observability), `tabLabel`/`tabDescription`, and the panel in
   `buildRouter`'s `panels` map.
5. Add every new string to `MESSAGE_IDS` in `locales/en.ts`. Export the panel
   from `packages/studio/src/index.ts`.

    **Verify**: `pnpm --filter "@cirrus/studio" run test` passes incl. a new
    `mail-panel.test.tsx` (renders list, selects a row, shows preview, handles
    empty + error); `lint:types` + `lint:eslint` exit 0.

### Step 4 — Cloudflare default transport + wire capture into the scaffold

1. Add `packages/mail/src/cloudflare-transport.ts`:
   `createCloudflareTransport({ send, from })` wrapping
   `@visulima/email/providers/cloudflare-email`'s `cloudflareEmailProvider`. The
   provider needs a `send(from, to, raw)` callback (RFC-822 raw message via the
   Worker `send_email` binding) — the transport accepts that callback so
   `@cirrus/mail` stays runtime-agnostic (no `cloudflare:email` import in the
   package; the scaffold supplies it). Reuse the same address validation path as
   the Resend transport. Export it from `index.ts`.
2. Make Cloudflare the **default** in `create-mailer.ts`: when no `transport` is
   supplied, build the Cloudflare transport from a `cloudflareSend` option
   instead of the Resend one. Keep Resend reachable via `transport:
createResendTransport(...)` (export that factory too). Update
   `create-mailer.test.ts` accordingly.
3. Edit `registry/mail/mail.ts` so `mailer()` selects the transport by env:
    - When capture is enabled, build `createMailer({ from, transport:
createCaptureTransport(<root-shard sink from env.SHARD>) })` — no provider
      creds required.
    - Otherwise build the Cloudflare default: pass a `cloudflareSend` that does
      `const { EmailMessage } = await import("cloudflare:email");
await env.SEND_EMAIL.send(new EmailMessage(from, to, raw));`.
    - **Trigger**: capture is on when `CIRRUS_MAIL_CAPTURE` is set **or** no
      `SEND_EMAIL` binding is present — so `cirrus dev` captures automatically
      (zero-config) and prod (binding present) sends via Cloudflare. Keep the
      decision in one small, well-commented helper in the scaffold.
4. Update `registry/mail/registry.json`: swap the `RESEND_API_KEY` env var for a
   `send_email` binding entry + a `MAIL_FROM` (and optional `CIRRUS_MAIL_CAPTURE`)
   var, and rewrite the `docs` string to describe Cloudflare Email Routing setup
   (verify a destination address, add the `send_email` binding) with Resend as an
   "or bring your own provider" note.

    **Verify**: `cirrus registry add mail` still applies cleanly (run the registry
    apply tests: `pnpm --filter "@cirrus/cli" run test` for the registry suite, or
    the registry golden tests if present); the scaffolded `mail.ts` typechecks.

### Step 5 — Playwright test helper + auth E2E

1. Add `packages/mail/src/testing.ts` exporting test-only helpers backed by the
   read admin RPC:
    - `waitForMail({ to, timeoutMs?, pollMs? })` — polls `getCapturedMail` for the
      newest message addressed to `to`, returns the `CapturedMail`.
    - `extractLink(mail, { match? })` — pulls the first URL out of `html`/`text`
      (optionally matching a substring like `/reset-password`), for reset /
      verification flows.
    - These need a way to call the admin RPC from a test process. Reuse the same
      transport the studio CLI server uses (`packages/cli/src/util/studio-server.ts`
      proxies `/_cirrus/rpc` with the admin token) — the helper takes a base URL +
      admin token and POSTs the `__cirrus_admin__:getCapturedMail` envelope. Do
      not pull the studio React bundle into the helper.
    - Add a `./testing` conditional export to `packages/mail/package.json` so it
      is importable as `@cirrus/mail/testing` without bloating the main entry.
2. Add a Playwright spec under `examples/auth-playground` that: signs up / hits
   forgot-password, calls `waitForMail({ to })`, `extractLink(...)`, visits the
   reset link, sets a new password, and asserts sign-in. Read the example's
   existing structure and Playwright config first; add only the spec + minimal
   glue.

    **Verify**: `pnpm --filter "@cirrus/mail" run test` covers `waitForMail`
    (against a fake RPC) + `extractLink`. The E2E spec runs locally against
    `cirrus dev` with capture on (note in the spec how to run it; do not require it
    in the default unit run if the harness can't boot a worker in CI — gate it
    like the existing template build-smoke matrix).

### Step 6 — Docs touch-up

Add a short "Mail catcher (dev)" section to `@cirrus/mail`'s README and a line in
the studio docs/redesign notes pointing the Mail panel out. Keep it tight; the
code is the contract.

## Test plan

- `@cirrus/mail`: capture transport records via a fake sink and returns the id;
  `extractLink` pulls reset/verify links from html and text; `waitForMail`
  resolves on a matching message and times out otherwise.
- `@cirrus/do`: `recordCapturedMail` inserts + returns id; `readCapturedMail`
  pages newest-first; bounded trim keeps ≤ N rows; the two admin RPC branches
  validate their payloads; the table is hidden by the `__cirrus` prefix.
- `@cirrus/studio`: panel renders the list, selecting a row shows the sandboxed
  preview, tabs switch html/text/headers, empty + error states render.
- E2E: forgot-password reset round-trips through the captured mail (gated run).

## Done criteria

- [ ] `createCaptureTransport` + `MailboxSink` + `CapturedMail` exported from
      `@cirrus/mail`; `@cirrus/mail/testing` exports `waitForMail` + `extractLink`.
- [ ] `__cirrus_mail` table + `recordMail`/`getCapturedMail` admin RPCs exist,
      record against the root shard, and are bounded-trimmed.
- [ ] Studio has a **Mail** tab showing a two-pane inbox with a sandboxed HTML
      preview; HTML cannot execute script in the studio.
- [ ] `registry/mail/mail.ts` selects capture in dev (no Resend key needed) and
      Resend in prod, with the decision documented.
- [ ] An `examples/auth-playground` spec drives forgot-password end-to-end via
      the captured mail.
- [ ] `pnpm --filter "@cirrus/mail" run test`, `… "@cirrus/do" run test`,
      `… "@cirrus/studio" run test` all pass; touched packages `lint:types` +
      `lint:eslint` clean; `pnpm run build:affected` exits 0.
- [ ] With capture **off** (Resend key present, flag unset), the mailer behaves
      byte-for-byte as before — no interception, no new I/O.

## STOP conditions

- The root-shard id / `runSql` indirection in `auth-metrics.ts` does not match
  this plan's assumptions (e.g. there is no root-shard convention, or admin RPCs
  cannot write) — stop and report; the storage location is a design decision.
- Adding the capture branch to `handleAdminRpc` would let a **production** worker
  accept injected mail through an exposed path — stop; the write RPC must be
  inert unless capture is explicitly active.
    - **Implementation note (accepted relaxation):** the DO has no signal for
      "capture is active", so `recordMail` is gated by `CIRRUS_ADMIN_TOKEN` alone —
      the same trust boundary that already protects `writeRow`/`clearTable`/
      `deleteRows`/`runSql`. A token holder can already mutate the shard, so a
      token-gated mailbox insert adds no new privilege. The worker only calls
      `recordMail` when the capture transport is wired (dev). Documented inline on
      `handleRecordMail`.
- `@cirrus/mail` would need to import `@cirrus/do` (a runtime/DO dependency) to
  implement the sink — stop; the sink must stay structural. Put DO-aware glue in
  `@cirrus/do` or the registry scaffold, not in `@cirrus/mail`.
- The studio bundle would gain a runtime import from `@cirrus/do` — stop; only
  plain strings/types cross that boundary (see `admin.ts` header).
- Sandboxing the HTML preview is not achievable without enabling script — stop;
  do not render untrusted captured HTML with scripts enabled.

## Maintenance notes

- A natural follow-up: capture **queued** mail too (`consumeQueuedSend` path) and
  show delivery status (captured / sent / failed) once a real transport runs in a
  preview env. Out of scope here.
- If plan 012 lands, its "Add email?" flow should offer to enable capture by
  default (scaffold `CIRRUS_MAIL_CAPTURE` / leave `RESEND_API_KEY` blank) so a
  fresh project has a working dev inbox with zero extra steps.
- The two new shadcn primitives (`resizable`, `tabs`) are now vendored — reuse
  them for future panels rather than re-adding.
