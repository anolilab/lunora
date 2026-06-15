# Plan 039: Workers for Platforms / Dispatch Namespaces

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

- **Priority**: P3 (Niche. Workers for Platforms is for SaaS platforms running _untrusted customer-authored Workers_ in a dispatch namespace. That is a fundamentally different product shape from Cirrus's "own your backend" positioning. No zeroback/Convex parity pressure here — neither offers it. This is a "say yes if a platform customer asks", not a roadmap item.)
- **Effort**: S for the honest minimum (validator awareness + a typed `env.DISPATCHER` accessor); L+ if Cirrus ever tried to _own_ the multi-tenant dispatch story (sandboxing, per-tenant limits, script upload API, outbound bindings) — which it should not.
- **Risk**: LOW for the minimal config surface; HIGH if mis-scoped into running untrusted code (security boundary, billing exposure, account-level Cloudflare entitlement required).
- **Depends on**: none
- **Category**: feature (new Cloudflare binding support)
- **Planned at**: commit `HEAD` (058071c8), 2026-06-15

## Verdict

**Do not build this as a core feature.** Dispatch namespaces (`env.DISPATCHER.get(name)`)
exist to run untrusted, customer-uploaded Workers — a multi-tenant SaaS-platform
use case that is orthogonal to Cirrus's value proposition (a type-safe backend
_you_ author). The honest deliverable is the **config-only minimum**: teach the
wrangler validator about `dispatch_namespaces` so a Cirrus project that _does_
need it isn't rejected, and optionally type `env.DISPATCHER` so it's not `unknown`.
Everything beyond that (script upload/management API wrappers, tenant isolation,
outbound bindings, tags/limits) is a separate product Cirrus should not absorb.
Be honest in the status row: **niche, config-passthrough only, not a package.**

## Current state

- `packages/config/src/remote-bindings.ts:56-64` — `dispatch_namespaces` is
  **not** in `REMOTE_ELIGIBLE_KEYS`. (Correct: dispatch namespaces have no
  "remote dev proxy" story the way KV/R2/D1 do, and the comment at lines 47-64
  deliberately omits sections with no `remote` schema field.) No change needed
  here.
- `packages/config/src/wrangler-validator.ts` — `WranglerConfig` (65-83) has no
  `dispatch_namespaces`. A wrangler config that declares one is not _rejected_
  (the validator only checks known keys), but it gets no Cirrus-side validation.
- `packages/config/src/infer-bindings.ts` — no inference. Correct: a dispatch
  namespace is account-level platform infrastructure, never inferable from app
  source. Leave inference untouched.
- `packages/codegen/src/emit.ts` — `env` is `Record<string, unknown>`
  (`emit.ts:1265` etc.), so `env.DISPATCHER` is already usable, just untyped.
  There is no emitted `Env` interface to hang a typed `DispatchNamespace` on
  (same gap noted in Plan 030).
- No package exists and none should. This is the most peripheral of the four
  binding plans.

What's missing (and worth adding): validator awareness of the `dispatch_namespaces`
shape so it's documented/passthrough-validated. What's _correctly_ missing and
should stay missing: inference, remote-dev proxying, a `ctx.*` facade, and any
multi-tenant runtime.

## Item breakdown

- [ ] Item 1: Validator passthrough for `dispatch_namespaces`
    - `packages/config/src/wrangler-validator.ts` — add to `WranglerConfig` (65-83): `dispatch_namespaces?: ReadonlyArray<{ binding?: string; namespace?: string; outbound?: unknown } | null | undefined>`. Add a minimal `validateDispatchNamespaces(wrangler, errors)` (model on `validateTailConsumers`, 300-322): each entry needs a non-empty `binding` and a non-empty `namespace`. Wire it into `validateWranglerConfig` (346-401). Keep validation _thin_ — do not validate `outbound` binding shapes (that's deep WfP territory Cirrus shouldn't police).
    - **Test**: `packages/config/__tests__/wrangler-validator.test.ts` — a malformed `dispatch_namespaces` entry (missing `binding`/`namespace`) errors; a well-formed entry passes; absent key is silent. Confirm that adding the key does **not** trip any "unknown binding" or DO/migration cross-checks.

- [ ] Item 2 (OPTIONAL): typed `env.DISPATCHER` accessor
    - Only if Plan 030's `CirrusServices`/`Env`-augmentation seam already exists (do not introduce a competing `Env` type for this niche binding). If it does: emit one optional `DispatchNamespace`-typed property per `dispatch_namespaces[].binding` into the same generated env-augmentation interface, read from the parsed wrangler config. Type the _result_ of `.get(name)` as a `Fetcher` (the dispatched script's fetch handler) and stop there — Cirrus cannot type a customer-uploaded Worker's RPC surface.
    - If Plan 030's seam does **not** exist yet, **skip this item** — do not build env-typing infrastructure for a P3 binding. Leave `env.DISPATCHER` as `Record<string, unknown>` access; document the cast users should apply.
    - **Test (only if implemented)**: a codegen fixture with a `dispatch_namespaces` entry emits the typed property; absent, emits nothing. Plain-Node golden assertion.

- [ ] Item 3: Documentation note (scope honesty)
    - In the plan-status update (and any future docs PR — do **not** create docs files here unless the user asks), record explicitly: Cirrus supports `dispatch_namespaces` as **wrangler config passthrough** (validated, optionally typed) for users who already operate a Workers-for-Platforms account; Cirrus does **not** provide script-upload/management, tenant isolation, or outbound-binding helpers. This sets the boundary so a future contributor doesn't mistake passthrough support for an endorsement to build the multi-tenant runtime.

## Verification

```bash
pnpm run build:packages
pnpm --filter "@cirrus/config..." run build
pnpm --filter "@cirrus/config" run test                  # validateDispatchNamespaces
pnpm --filter "@cirrus/config" run lint:types
# Item 2 only (if Plan 030's env-augmentation seam exists):
pnpm --filter "@cirrus/codegen..." run build
pnpm --filter "@cirrus/codegen" run test
```

- Pure config-parsing/string-emit tests, all plain-Node. No workerd, no runtime, no package. Running an actual dispatched Worker requires a Workers-for-Platforms account entitlement and cannot be tested in CI or this sandbox — explicitly out of scope.

## STOP conditions

- The task is reinterpreted as "build multi-tenant Worker execution / script upload / tenant isolation" — **stop immediately and report**. That is a separate product with a security boundary Cirrus must not casually own.
- Item 2 would require introducing a new generated `Env` type _solely_ for dispatch namespaces (Plan 030's seam absent) — skip Item 2; do not build env-typing for a P3 binding.
- The drift check shows `wrangler-validator.ts` moved the cited line ranges — re-locate before editing.
- Anyone proposes adding `dispatch_namespaces` to `REMOTE_ELIGIBLE_KEYS` — reject: it has no `remote` schema field and no remote-dev proxy semantics (see `remote-bindings.ts:47-64`).
