# Plan 233 — Multi-implementation parity as a checked CI artifact (design spike)

**Baseline:** `36421ad58` (2026-08-01)
**Status:** DONE (spike) — two static parity tests shipped; behavioral-suite question answered below, not built

## 0. Headline finding

Two five-way-duplicated surfaces (auth-ui's `create*Controller` factories, and
the React/Vue/Solid/Svelte/Angular adapter export surface) had no mechanism
stopping "shipped in some implementations, not others" from going unnoticed
until an audit. Both now have a static test: `packages/auth-ui/__tests__/core/port-parity.test.ts`
and `packages/client/__tests__/adapter-export-parity.test.ts`. Both read their
source of truth dynamically (the barrel file itself, not a hand-copied list),
carry an annotated allow-list for the exceptions, and were each demonstrated —
by temporarily breaking them — to actually fail on a real gap.

The adapter manifest surfaced a structural fact worth stating up front: the
five adapters do **not** share an export naming convention, by design (React
and Vue use `use*`, Solid uses `create*`, Svelte and Angular export bare
nouns). A literal-name check (`useQuery` present everywhere) would have been
false parity, flagging Solid's `createQuery` as a "gap" next to nothing
missing. The manifest maps each feature to the adapter's actual name instead —
see §2.

## 1. What shipped

### 1.1 `packages/auth-ui/__tests__/core/port-parity.test.ts`

Reads every `create*Controller` value-export out of `packages/auth-ui/src/core/index.ts`
via a regex over `export { ... }` blocks (excluding `export type { ... }` — the
`type` keyword sits between `export` and `{`, so the block regex can't match
past it). For each, greps the five port source trees (`src/react`, `src/vue`,
`src/solid`, `src/svelte`, `src/angular`) for a whole-word reference. A
controller with zero consumers fails the test unless it's on
`DELIBERATELY_UNMOUNTED` with a reason.

Verified live: removing the `createActiveMemberController` entry from the
allow-list turns its check red (`expected { …(7) } to have property
"createActiveMemberController"`); restoring it turns the suite green again. A
fourth test (`"proves the allow-list is load-bearing"`) asserts this
mechanically on every run, so the demonstration isn't just something done once
by hand.

### 1.2 `packages/client/__tests__/adapter-export-parity.test.ts`

A `REQUIRED_SURFACE` manifest of 23 features (query, mutation, mutator,
subscription, paginated/infinite query, presence, connection status, flags,
auth + auth-gates, upload, rate limit, stream, voice agent, the four agent
hooks, `hydratePreloaded`, the client-access primitive, and the one confirmed
gap, HTTP streaming) × 5 adapters = 115 cells, plus one manifest sanity check.
Each cell names the adapter's actual export and the module it should come
from (defaulting to `src/index.ts`; `upload` points at `src/upload.ts`
instead — see §2). The test reads that module's real exports back with the
same block-regex technique as §1.1 and asserts presence.

It lives in `@lunora/client`, not any one adapter, because `@lunora/client` is
the shared core all five depend on and the plan's own non-drifting
counterexample: `@lunora/client/pagination`, imported by every adapter's
paginated wrapper, has produced zero parity findings across every audit wave.
Putting the manifest there — reading sibling packages' source by path, no new
dependency edge — generalizes that pattern instead of picking one adapter
package to own a concern that isn't really its own.

Verified live: flipping Angular's `upload` entry from its documented gap to a
false claim (`{ name: "useUpload" }`) turns the check red (`@lunora/angular
does not export "useUpload" from index.ts`); reverting restores 116/116
green.

## 2. The two allow-lists

### 2.1 auth-ui `DELIBERATELY_UNMOUNTED` (8 entries)

| Controller                            | Reason                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `createActiveMemberController`        | orphan — no port wires org active-member switching yet (plan 233 evidence); still unaddressed on this base                                    |
| `createBackupCodeSignInController`    | orphan — no port wires backup-code sign-in yet; still unaddressed                                                                             |
| `createPhoneForgotPasswordController` | orphan — no port wires phone-based password-reset request yet; still unaddressed                                                              |
| `createPhoneResetPasswordController`  | orphan — no port wires phone-based password reset yet; still unaddressed                                                                      |
| `createPhoneVerifyController`         | orphan — no port wires phone verification yet; still unaddressed                                                                              |
| `createResetPasswordOtpController`    | orphan — no port wires OTP-based password reset yet; still unaddressed                                                                        |
| `createFormController`                | generic form-builder primitive — every domain controller that needs a form calls it internally; never mounted by a port directly              |
| `createResourceController`            | generic resource-fetch primitive — every domain controller that lists/fetches something calls it internally; never mounted by a port directly |

The first six match the plan's cited evidence exactly and are still open on
this base — the drift check (`git diff --stat ad873e805..HEAD -- packages/auth-ui
packages/react packages/vue packages/solid packages/svelte packages/angular`)
showed only `CHANGELOG.md`/`package.json` version-bump churn between the
plan's baseline and this spike's, so none of the six had landed on an
in-flight branch by the time this ran. The last two (`createFormController`,
`createResourceController`) are **not** in the plan's original list — they
surfaced because the test reads the export list dynamically rather than using
the hand-copied six, exactly the drift the dynamic read is meant to catch.
They're structurally different from the other six: builder primitives other
controllers call, never flows a port renders directly, so "mount this in a
port" is not a meaningful ask for them.

### 2.2 Adapter manifest gap entries (3 features, plus the unused `ADAPTER_OPT_OUTS` escape hatch)

| Feature      | Adapter(s)                  | Reason                                                                                                                                                                                                                              |
| ------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload`     | Angular                     | no `upload.ts` and no `./upload` subpath — chunked/multipart/TUS/paste upload was never ported; plan 233's cited evidence, confirmed still open on this base                                                                        |
| `httpStream` | Vue, Solid, Svelte, Angular | React-only today; nobody has ported the SSE-style HTTP-stream hook                                                                                                                                                                  |
| `authGates`  | Svelte, Angular             | no JSX-like "conditionally render a subtree" component primitive to build `Authenticated`/`AuthLoading`/`Unauthenticated` from — a Svelte/Angular consumer gates its template directly off the `auth` store/signal's fields instead |

`upload` is a real, still-open regression-shaped gap (plan 233 evidence,
confirmed by `find` — no `packages/angular/src/upload.ts`, no `./upload` in
`packages/angular/package.json` `exports`). `httpStream` is a real "nobody's
ported this yet" gap, not previously called out by the plan but found while
building the manifest. `authGates` is the one genuine framework-shape
non-fit the plan's STOP condition anticipated ("Angular's DI model etc.") —
Svelte and Angular have no component model to build a JSX-style gate from at
all, so there's nothing to port; the reason says so rather than reading like
an open bug.

`ADAPTER_OPT_OUTS` (a per-adapter, per-feature reason map) exists as the
escape hatch for a feature that turns out to not apply to one adapter's
programming model at all — used by none of the 23 features today, because
`authGates`' per-adapter `gap` entries covered that case adequately. Kept so
the next such case doesn't have to invent the mechanism.

## 3. Naming-convention variance — bigger than the plan's example, still manageable

The plan's STOP condition named "Angular's DI model" as the kind of
legitimate per-framework variance to expect. What was actually found is
broader: **every** adapter uses a different export-naming convention for
nearly every feature (`useQuery` / `useQuery` / `createQuery` / `query` /
`liveQuery` across React/Vue/Solid/Svelte/Angular for the same live-query
primitive). This is by design — Svelte's own header comment maps its bare
nouns back to React's `use*` names for readers — not drift.

This did not make the manifest low-value; it changed its shape. Instead of
asserting one literal name everywhere, `REQUIRED_SURFACE` maps each feature to
the adapter's actual name, and the test still asserts presence of that real
export. The Angular-`upload` demonstration in §1.2 shows the manifest catches
a real regression despite the naming variance — the variance is orthogonal to
whether a feature exists, not a reason parity-checking adds nothing. **Not a
STOP**: the manifest is still worth having, it just had to be designed around
per-adapter names from the start rather than retrofitted with opt-outs.

## 4. Open question: is a shared behavioral conformance suite worth building?

Both tests shipped here are **static** — they check that a name is exported
from the right file, nothing about what calling it does. They would not have
caught the plan's other two cited findings: `packages/react/src/use-presence.ts`'s
missing `document` guard, or `packages/svelte/src/presence.ts`'s missing SSR
guard — both are runtime behavior, invisible to an export-surface check
(`usePresence`/`presence` exists in both; the bug is in what it does when
called during SSR or without a `document`).

Closing that class of bug needs a **behavioral** conformance suite: the same
assertions run against all five adapters through a per-adapter mount/unmount
driver, structured like `@lunora/platform/conformance`'s TCK for platform
hosts but for framework adapters instead of Cloudflare/AWS/etc.

**Recommendation: build it, but scoped and after this lands, not as part of
this spike.** Reasoning:

- **Cost is real but bounded if scoped narrowly.** A driver needs five mount
  harnesses (React Testing Library, `@vue/test-utils`, `@solidjs/testing-library`,
  `@testing-library/svelte`, and Angular's `TestBed` — four of which the
  package already has test infrastructure for per `packages/auth-ui/vitest.config.ts`'s
  five-project split). The assertions themselves can be framework-neutral
  (mock `LunoraClient`, assert on the resolved DOM/state), but the setup/mount
  boilerplate is genuinely five-times duplicated and is the part that will
  rot if unmaintained.
- **The payoff is exactly the SSR/`document`-guard class of bug**, which this
  spike's static tests structurally cannot reach, and which is the kind of
  bug that ships silently (works everywhere in dev, breaks only under SSR or
  a specific host).
- **Start with 4 features, not all 23.** Presence, connection status,
  pagination, and flags — the plan's own suggested scope. These four share a
  useful property: each has an observable state machine (connecting →
  connected → data; loading → loaded/error) that's easy to assert
  identically across adapters, and each is a hook family already implicated
  in a real cross-adapter finding (`usePresence`'s guard drift) or is the
  plan's cited non-drifting counterexample (pagination), giving the first
  run of the suite something to prove itself against in both directions —
  catching a known-bad case and staying quiet on a known-good one.
- **Don't generalize past those four before the first run's maintenance cost
  is known.** If the mount-harness boilerplate turns out cheap to keep in
  sync (most likely, since it only needs to change when an adapter's test
  library major-bumps), extend feature-by-feature. If it rots fast, the
  static export-parity test from this spike is the fallback floor — it's
  cheap, already shipped, and still worth keeping regardless of what happens
  with the behavioral suite.

## 5. Next steps

1. File a follow-up implementation plan for the 4-feature behavioral suite
   (§4), scoped to presence / connection status / pagination / flags, with
   its own mount-harness design per adapter.
2. When plan 231 lands the `upload` and `httpStream` gaps, delete the
   corresponding `gap` entries from `REQUIRED_SURFACE` — their absence
   turning red is exactly the signal that the manifest is stale, per §1.2's
   verification.
3. When a port picks up one of the six orphaned auth-ui controllers
   (§2.1), drop its `DELIBERATELY_UNMOUNTED` entry — the "stale entries"
   test in `port-parity.test.ts` catches a forgotten one, but the drop
   itself is manual.
