# Plan 042: mTLS Client Certificates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, tick the checkboxes and update this
> plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 058071c8..HEAD -- packages/config/src/wrangler-validator.ts packages/config/src/remote-bindings.ts packages/config/src/infer-bindings.ts packages/codegen/src/emit.ts`.
> If any in-scope file changed since this plan was written, compare against live
> code before proceeding; on mismatch treat as a STOP condition.

## Status

- **Priority**: P3 (Niche. mTLS client certificates let a Worker present a client cert on outbound `fetch` to a mutually-authenticated upstream — banking/healthcare/enterprise-API integrations. Real but rare; no zeroback/Convex parity dimension. A "support it cleanly when asked", not a roadmap driver.)
- **Effort**: S (validator awareness + optional typed `env.<CERT>` accessor; the binding's whole runtime API is `env.<CERT>.fetch(...)`, which already works untyped.)
- **Risk**: LOW (a leaf outbound binding; no DO/runtime/state surface; cert material lives in Cloudflare, never in Lunora code).
- **Depends on**: none
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

**Config-passthrough only — no package.** An mTLS certificate binding is a
`Fetcher` whose entire API is `env.MY_CERT.fetch(request)`: a normal `fetch` that
transparently presents the configured client certificate to the upstream. There
is nothing to wrap — no per-request facade, no JSON helpers, no state. The honest
deliverable is: teach the wrangler validator about `mtls_certificates` so a
project that needs it validates cleanly, and (optionally, only if Plan 030's
env-typing seam exists) type `env.<CERT>` as a `Fetcher`. The cert is uploaded
via `wrangler mtls-certificate upload` and referenced by `certificate_id`; Lunora
neither manages nor stores cert material. Keep this small and decline to build a
package.

## Current state

- `packages/config/src/remote-bindings.ts:56-64` — `mtls_certificates` is **not**
  in `REMOTE_ELIGIBLE_KEYS`, and correctly so: an mTLS binding has no "deployed
  resource to proxy in dev" semantics distinct from local — the cert is an
  account resource referenced by id, and the binding behaves identically in local
  and remote dev. No change needed.
- `packages/config/src/wrangler-validator.ts` — `WranglerConfig` (65-83) has no
  `mtls_certificates`. A config declaring one is not rejected, but gets no
  Lunora-side shape check.
- `packages/config/src/infer-bindings.ts` — no inference, correctly: an mTLS
  binding is hand-authored config tied to an uploaded cert id; nothing in app
  source implies it. Leave inference untouched.
- `packages/codegen/src/emit.ts` — `env` is `Record<string, unknown>`
  (`emit.ts:1265` etc.), so `env.MY_CERT.fetch(...)` already works untyped. No
  emitted `Env` type to hang a `Fetcher` on (same gap as Plans 030/039).
- No package exists and none should.

What's worth adding: validator awareness. What should stay absent: inference,
remote-dev proxying, a package, any `ctx.*` facade.

## Item breakdown

- [x] Item 1: Validator passthrough for `mtls_certificates`
    - `packages/config/src/wrangler-validator.ts` — add to `WranglerConfig` (65-83): `mtls_certificates?: ReadonlyArray<{ binding?: string; certificate_id?: string } | null | undefined>`. Add a thin `validateMtlsCertificates(wrangler, errors)` (model on `validateTailConsumers`, 300-322): each entry needs a non-empty `binding` and a non-empty `certificate_id`. Wire into `validateWranglerConfig` (346-401).
    - **Test**: `packages/config/__tests__/wrangler-validator.test.ts` — a malformed entry (missing `binding` or `certificate_id`) errors; a well-formed `{ binding, certificate_id }` passes; absent key is silent; confirm it triggers no DO/migration cross-checks.

- [ ] Item 2 (OPTIONAL): typed `env.<CERT>` accessor
    - Only if Plan 030's `LunoraServices`/`Env`-augmentation seam already exists — reuse it; do **not** create a competing `Env` type for this niche binding. If the seam exists: emit one optional `Fetcher`-typed property per `mtls_certificates[].binding`, read from the parsed wrangler config. That's the full surface — `Fetcher` _is_ the mTLS binding's type.
    - If Plan 030's seam is absent, **skip this item**. `env.<CERT>.fetch(...)` works fine via `Record<string, unknown>`; document the cast (`(env.MY_CERT as Fetcher).fetch(req)`).
    - **Test (only if implemented)**: a codegen fixture with an `mtls_certificates` entry emits the typed `Fetcher` property; absent, emits nothing. Plain-Node golden assertion.

- [x] Item 3: Documentation note (scope honesty)
    - In the plan-status update (do **not** create docs files here unless asked): record that Lunora supports `mtls_certificates` as **wrangler config passthrough** (validated, optionally typed). Cert upload/rotation is done via `wrangler mtls-certificate upload`; Lunora never handles cert/key material. This pins the boundary so no one mistakes passthrough support for a cert-management feature.

## Verification

```bash
pnpm run build:packages
pnpm --filter "@lunora/config..." run build
pnpm --filter "@lunora/config" run test                  # validateMtlsCertificates
pnpm --filter "@lunora/config" run lint:types
# Item 2 only (if Plan 030's env-augmentation seam exists):
pnpm --filter "@lunora/codegen..." run build
pnpm --filter "@lunora/codegen" run test
```

- Pure config-parsing/string-emit tests, all plain-Node. No workerd, no package. An actual mTLS handshake requires an upstream that demands client certs plus an uploaded Cloudflare cert — cannot be tested in CI or this sandbox; explicitly out of scope.

## STOP conditions

- The task is reinterpreted as "manage/upload/rotate certificates" or "store cert material in Lunora" — **stop and report**. Lunora must never touch cert/key bytes; that stays in Cloudflare's mTLS cert store.
- Item 2 would require a new generated `Env` type _solely_ for this binding (Plan 030's seam absent) — skip Item 2.
- The drift check shows `wrangler-validator.ts` moved the cited line ranges — re-locate before editing.
- Anyone proposes adding `mtls_certificates` to `REMOTE_ELIGIBLE_KEYS` — reject: it has no `remote` schema field and identical local/remote behavior (see `remote-bindings.ts:47-64`).
