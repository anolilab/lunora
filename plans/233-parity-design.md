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

Both tests read their export lists through one shared helper,
`packages/client/__tests__/lib/named-exports.ts`'s `namedValueExportsOf`,
built on `ts-morph`'s `SourceFile#getExportedDeclarations()` rather than a
hand-rolled `export { ... }` block regex. The two tests used to each carry
their own copy of that regex (plus an "as alias" regex and a manual
block-scan loop); both were blind to `export * from "./x"` re-exports,
working only because every barrel they read happens to use explicit
`export { ... }` today. `getExportedDeclarations()` resolves star re-exports,
`export { x } from`, and `export { a as b }` aliases uniformly, and — same as
the regex — excludes `export type { ... }`. It lives under `@lunora/client`'s
`__tests__` (not either consumer's own tree) for the same "shared core, no
new dependency edge" reason §1.2 gives for the manifest test itself; auth-ui
imports it by relative path exactly the way the manifest test already reads
sibling adapters' source.

### 1.1 `packages/auth-ui/__tests__/core/port-parity.test.ts`

Reads every `create*Controller` value-export out of
`packages/auth-ui/src/core/index.ts` via the shared helper. For each, greps
the five port source trees (`src/react`, `src/vue`, `src/solid`,
`src/svelte`, `src/angular`) for a whole-word reference. A controller with
zero consumers fails the test unless it's on `DELIBERATELY_UNMOUNTED` with a
reason.

Verified live: removing the `createActiveMemberController` entry from the
allow-list turns its check red; restoring it turns the suite green again. A
fourth test (`"proves the allow-list is load-bearing"`) asserts this
mechanically on every run — checking the real predicate the per-controller
check evaluates (no port consumer AND not on the reduced allow-list), not
merely that `Object.entries(...).filter(...)` removed the key it was told to
remove, which an earlier draft asserted and which could never fail regardless
of whether the parity check worked.

### 1.2 `packages/client/__tests__/adapter-export-parity.test.ts`

A `REQUIRED_SURFACE` manifest of 23 features (query, mutation, mutator,
subscription, paginated/infinite query, presence, connection status, flags,
auth + auth-gates, upload, rate limit, stream, voice agent, the four agent
hooks, `hydratePreloaded`, the client-access primitive, and the one confirmed
gap, HTTP streaming) × 5 adapters = 115 cells, plus manifest and subpath
sanity checks. Each cell names the adapter's actual export and the module it
should come from (defaulting to `src/index.ts`; `upload` points at
`src/upload.ts` instead — see §2).

It lives in `@lunora/client`, not any one adapter, because `@lunora/client` is
the shared core all five depend on and the plan's own non-drifting
counterexample: `@lunora/client/pagination`, imported by every adapter's
paginated wrapper, has produced zero parity findings across every audit wave.
Putting the manifest there — reading sibling packages' source by path, no new
dependency edge — generalizes that pattern instead of picking one adapter
package to own a concern that isn't really its own.

Verified live: flipping Angular's `upload` entry from its documented gap to a
false claim (`{ name: "useUpload" }`) turns the check red (`@lunora/angular
does not export "useUpload" from index.ts`); reverting restores it to green.

Two things a `src/index.ts`/`src/upload.ts` export check alone cannot catch,
closed in this pass:

- **A filled gap staying green forever.** Each `gap` entry now also carries
  the export name it's gapping, following that adapter's own naming
  convention (e.g. Vue's `httpStream` gap names `useHttpStream`, matching the
  `use*` convention its real entries use). The gap check asserts that name is
  still ABSENT from the adapter's barrel — so the day a port ships `httpStream`
  or Angular ships `upload`, the corresponding gap cell goes red instead of
  staying green next to a manifest that's now lying. Verified live: adding a
  `useHttpStream` export to `packages/vue/src/index.ts` turns Vue's
  `httpStream` gap cell red (`is on the gap list ("...") but @lunora/vue now
exports "useHttpStream"...`); removing it restores green.
- **`upload`'s subpath silently disappearing.** The file-level check only
  proves `src/upload.ts` exports the right name; it never looks at
  `package.json`. A separate assertion resolves each subpath-backed feature's
  export through the adapter's `package.json` `exports` map instead (currently
  just `upload`'s `./upload`), so dropping the subpath entry — even with
  `src/upload.ts` untouched — fails independently of the file-level check.

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

### 2.2 Adapter manifest gap entries (3 features)

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

Each gap entry also carries the export name it's gapping, following that
adapter's own naming convention (e.g. `httpStream`'s Vue entry names
`useHttpStream`, matching the `use*` convention `query`/`stream`/etc. already
use there) — see §1.2 for what that buys.

An earlier draft carried a per-adapter, per-feature `ADAPTER_OPT_OUTS` escape
hatch alongside the `gap` mechanism, for a feature that turns out not to
apply to one adapter's programming model at all. It was never used — every
exception the manifest needed, `authGates` included, was already expressible
as a per-adapter `gap` entry with a reason — so it was dead code carrying a
second way to say the same thing, and has been removed. Reintroduce it only
against a real feature that a `gap` entry genuinely can't express.

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
