# Plan 447: Split the capability probe into "module imported" vs "ctx surface read"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/codegen/src/discover-feature-usage.ts packages/codegen/src/platform-target.ts packages/codegen/src/declaration-surface.ts packages/codegen/src/run-codegen.ts packages/codegen/src/capabilities.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `1699f4317`, 2026-08-21

## Why this matters

`discoverFeatureUsage` decides that an app "uses" a capability if it either
**imports the capability's module** _or_ **reads the capability's `ctx.*` property**.
One boolean, one meaning, for all 19 capabilities. But several capability modules
export **binding-free helpers** — pure functions that need no Cloudflare binding at
all:

- `@lunora/bindings/images` exports `buildImageDeliveryUrl`, `buildSignedImageUrl`,
  `verifySignedImageUrl` — WebCrypto-only URL minting and verification.
- `@lunora/storage` exports `buildSignedUrl`, `verifySignedUrl`, `buildPresignedUrl`.

An app that imports one of those helpers and never touches `ctx.storage` gets the
capability flipped on, and `gateAgainstMatrix` then raises an **error-level**
`platform_unsupported_feature` on any target whose matrix rates `objectStorage` as
`unsupported` — telling the user to remove a call that would have run fine, and
omitting a `ctx.storage` surface they were not using anyway.

The single boolean is the defect. It is not a storage-specific or an images-specific
bug: any capability whose module also ships binding-free helpers has it, and the next
one added inherits it silently.

## Current state

### The uniform probe — `packages/codegen/src/discover-feature-usage.ts:132-147`

```ts
for (const capability of CAPABILITIES) {
    if (usage[capability.key]) {
        continue;
    }

    if (importSpecifiers.has(capability.moduleSpecifier)) {
        usage[capability.key] = true;

        continue;
    }

    if (capability.contextProperty !== undefined && contextProperties.has(capability.contextProperty)) {
        usage[capability.key] = true;
    }
}
```

`FeatureUsage` is `Record<CapabilityKey, boolean>` (`discover-feature-usage.ts:29`).

### The gate — `packages/codegen/src/platform-target.ts:221-262`

`gateAgainstMatrix` walks `CAPABILITY_TO_FEATURE` and, for each capability whose usage
is `true`, flips it off and pushes an `error`-level diagnostic when the target's matrix
rates the feature `unsupported` (or omits it → `platform_undeclared_feature`).

`CAPABILITY_TO_FEATURE` (`platform-target.ts:175-188`) is the gated set:

```ts
const CAPABILITY_TO_FEATURE: Partial<Record<CapabilityKey, PlatformFeatureKey>> = {
    ai: "ai",
    analytics: "analytics",
    browser: "browser",
    container: "containers",
    hyperdrive: "hyperdrive",
    kv: "keyValueStore",
    mail: "mail",
    pipelines: "pipelines",
    scheduler: "scheduler",
    storage: "objectStorage",
    vectors: "vectorStore",
    workflows: "workflows",
};
```

### Evidence corrections vs. the original finding

Two, both verified against live source:

1. **`images` is not gated today.** It has no `CAPABILITY_TO_FEATURE` entry, and the
   map's docblock (`platform-target.ts:151-155`) says so deliberately: "A key with no
   entry is an app-level add-on with no platform-portability meaning (feature flags,
   the Cloudflare-Access identity facade, Cloudflare Images, R2 SQL, payments, x402) —
   never gated, always emitted, on every target." So the _reachable_ bad diagnostic
   today is **`storage` only**. `images` is the latent case — it becomes reachable the
   moment someone adds `images: "images"` to that map, which is exactly the kind of
   one-line change nobody would think to guard.
2. **The codegen capability key is `storage`, not `objectStorage`.** `objectStorage` is
   the `@lunora/platform` _feature_ key it maps to. The row is
   `{ contextProperty: "storage", key: "storage", moduleSpecifier: "@lunora/storage" }`
   (`capabilities.ts:223`).

Neither correction changes the finding: the probe is uniformly too coarse and the
`storage` arm is live today.

### Why narrowing the probe naively breaks binding provisioning

`featureUsage.<key>` is read by **two** consumers, and they want different things:

- **Type-surface gating** (`declaration-surface.ts:262-274`) — should follow the
  `ctx.*` read. An app that never reads `ctx.images` does not need the `ctx.images`
  field emitted.
- **Binding provisioning** (`run-codegen.ts:756-783`, the `emitApp(...)` call) — must
  follow the **module import**. `hasImages: featureUsage.images` (`run-codegen.ts:769`)
  decides whether the generated worker wires the Images binding. An app that builds the
  facade directly (`createImages(env.IMAGES)`) and never writes `ctx.images` still needs
  that binding provisioned; flipping this to a ctx-only signal would silently unwire it.

Note `storage` already routes provisioning through a _different_, wider signal —
`hasStorage: studioFeatures.storage` (`run-codegen.ts:780`) — while `hasImages` reads
`featureUsage.images` raw. That asymmetry is why the change has to be threaded
deliberately rather than applied with a find-and-replace.

## Existing seams (do not reinvent)

- **`CAPABILITIES`** (`packages/codegen/src/capabilities.ts`) is the single canonical
  table; `CapabilityKey` is derived from it, so a record keyed by capability gets
  exhaustiveness checking for free. Any new signal must be keyed off it the same way
  `FeatureUsage` already is — do not introduce a hand-maintained parallel list.
- **`contextPropertiesRead(sourceFile)`** (`discover-feature-usage.ts:84-110`) already
  computes the per-file `ctx.*` read set in one pass. The ctx signal is already
  separately computed inside the loop; it is only the _storage_ of the two signals that
  is collapsed.
- **`buildStudioFeatures`** already demonstrates the pattern of OR-ing a code-usage flag
  with wider project signals to answer a different question. The split proposed here is
  the same idea one level down.

## The behavioural contract to preserve

1. **Emitted output must not change for any existing app or fixture.** On the default
   `cloudflare` target the matrix marks nothing unsupported, so the gate is the identity
   today — the goldens under `packages/codegen/__tests__/fixtures/` must stay
   byte-identical.
2. **Binding provisioning must not narrow.** Every `has*` flag passed to `emitApp` must
   keep its current (import-inclusive) truth value.
3. `buildStudioFeatures`' nav gating must keep its current truth values — it answers
   "is this page relevant?", which the import signal legitimately satisfies.

## Design decisions

**D1 — Two records, not a widened value type.**
Return `{ imported: Record<CapabilityKey, boolean>; contextRead: Record<CapabilityKey, boolean> }`
(or an equivalent named pair) rather than turning `FeatureUsage`'s value into an enum /
bitfield. Chosen because every existing call site reads `featureUsage.<key>` as a
boolean; a widened value type would force ~30 call-site edits with no reader that wants
the third state. A second parallel record is the smaller diff and keeps
`Record<CapabilityKey, boolean>` exhaustiveness on both halves.

**D2 — Gate on `contextRead`; provision on `imported`.**
`gateAgainstMatrix` takes the ctx-read set. `emitApp`/`emitServer`'s `has*` flags keep
reading the import-inclusive set. Chosen over "gate on the OR and downgrade the
diagnostic to `warn`": a warning still tells the user something false, and the whole
point of the error level (per the `PlatformDiagnostic.level` doc, `platform-target.ts:194`)
is that "All three names are errors — each drops or misdirects an emitted surface". A
capability the app never reads through `ctx` has no surface to drop.

**D3 — Cover all capabilities, not just `storage` and `images`.**
The split is applied to the whole `CAPABILITIES` table. Chosen over an allowlist of
"capabilities with binding-free helpers": such a list would be hand-maintained, would
have to be updated by whoever adds the next pure helper, and is exactly the drift the
`CapabilityKey`-derived design elsewhere in this file exists to prevent.

**D4 — `FeatureUsage`'s existing name keeps its existing meaning.**
The OR'd flag is still what `buildStudioFeatures` and the `has*` flags want. Renaming it
would churn every call site for no behaviour change. Add the new signal beside it.

## Commands you will need

| Purpose      | Command                                           | Expected on success |
| ------------ | ------------------------------------------------- | ------------------- |
| Install      | `pnpm install`                                    | exit 0              |
| Build deps   | `pnpm --filter "@lunora/codegen..." run build`    | exit 0              |
| Tests        | `pnpm --filter "@lunora/codegen" run test`        | all pass            |
| Typecheck    | `pnpm --filter "@lunora/codegen" run lint:types`  | exit 0              |
| Lint         | `pnpm --filter "@lunora/codegen" run lint:eslint` | exit 0              |
| API snapshot | `pnpm run api:check`                              | exit 0              |
| Full build   | `pnpm run build:packages`                         | exit 0              |

## Scope

**In scope**:

- `packages/codegen/src/discover-feature-usage.ts` — return both signals
- `packages/codegen/src/platform-target.ts` — `gatePlatformFeatures` / `gateAgainstMatrix`
  gate on the ctx-read signal
- `packages/codegen/src/declaration-surface.ts` — thread the second signal through
- `packages/codegen/src/run-codegen.ts` — thread the second signal through; keep every
  `has*` flag on the import-inclusive signal
- `packages/codegen/__tests__/discover-feature-usage.test.ts`
- `packages/codegen/__tests__/platform-target.test.ts`

**Out of scope**:

- `packages/codegen/src/capabilities.ts` — the table needs no new facet; the split is
  about how the probe _stores_ its answer, not about what the capabilities are.
- Adding `images` to `CAPABILITY_TO_FEATURE` — a separate decision with its own
  platform-parity implications. Do not fold it in.
- `packages/platform` capability matrices.
- Golden fixtures — must not change.

## Git workflow

- Branch: `improve/followup-capability-probe-split`
- Commit: `fix(codegen): gate platform on ctx reads, not imports` (50 chars)

## Steps

### Step 1: Add the second signal to the probe

In `packages/codegen/src/discover-feature-usage.ts`, keep the existing `FeatureUsage`
record and add a second `Record<CapabilityKey, boolean>` populated only from the
`contextProperties.has(capability.contextProperty)` arm. Both are built with the same
`Object.fromEntries(CAPABILITIES.map(...))` construction, so both stay exhaustive.

Two details the current loop's shape will fight you on, and both must be handled:

1. The `if (usage[capability.key]) continue;` short-circuit and the
   `if (CAPABILITIES.every(...)) break;` early exit are keyed on the OR'd flag. With two
   signals, a capability whose import was already seen must still be checked for a ctx
   read in later files. Either drop the short-circuits or make them require **both**
   signals set.
2. `mail` is import-only by design (`discover-feature-usage.ts:23-27`: "it has no
   `ctx.mail` helper"). Its ctx-read signal will therefore always be `false`. Since
   `mail` IS in `CAPABILITY_TO_FEATURE`, gating on ctx-read alone would make `mail`
   ungateable. Decide and document: either exempt capabilities with no
   `contextProperty` from the narrowing (their import IS the only signal, so it is the
   right one), or handle it explicitly. Write the reason in the code, not just here.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: Update the tests' `ALL_OFF` literals

Both `packages/codegen/__tests__/discover-feature-usage.test.ts:14-34` and
`packages/codegen/__tests__/platform-target.test.ts:13` declare an `ALL_OFF: FeatureUsage`
object literal listing all 19 keys explicitly:

```ts
const ALL_OFF: FeatureUsage = {
    access: false,
    ai: false,
    analytics: false,
    browser: false,
    container: false,
    flags: false,
    hyperdrive: false,
    images: false,
    kv: false,
    mail: false,
    notify: false,
    payments: false,
    pipelines: false,
    r2sql: false,
    scheduler: false,
    storage: false,
    vectors: false,
    workflows: false,
    x402: false,
};
```

Every construction of the new signal in a test needs the same literal. Extract one
shared `ALL_OFF` helper rather than copying a third 19-key literal — a
`Object.fromEntries(CAPABILITIES.map((c) => [c.key, false]))` with a single cast is the
smaller thing to maintain.

**Verify**: `grep -c "false," packages/codegen/__tests__/platform-target.test.ts` before
and after; and `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 3: Gate on the ctx-read signal

Change `gateAgainstMatrix` / `gatePlatformFeatures` (`platform-target.ts:221`, `:297`) so
the _gating decision_ reads the ctx-read signal, while `PlatformGateResult.usage` (which
`declaration-surface.ts:227` unpacks as `featureUsage`) still returns the flags the type
emitter expects.

Be explicit about what `gated[capability] = false` now means: it suppresses the emitted
`ctx.<capability>` **type surface**, and it must not suppress the corresponding binding
provisioning in `emitApp`.

**Verify**: `pnpm --filter "@lunora/codegen" run test -- platform-target` → all pass.

### Step 4: Prove provisioning did not narrow

Audit every `has*` flag at `run-codegen.ts:692-704`, `run-codegen.ts:756-783`, and
`declaration-surface.ts:262-274`. Each must still be fed the import-inclusive signal.
Pay particular attention to `hasImages: featureUsage.images` (`run-codegen.ts:769`),
which is the one flag reading the raw record while its sibling `hasStorage` reads
`studioFeatures.storage`.

**Verify**:

- `pnpm run build:packages` → exit 0
- `git status --porcelain packages/codegen/__tests__/fixtures/` → **empty**

### Step 5: Regression tests for the actual finding

Add to `packages/codegen/__tests__/platform-target.test.ts`:

1. An app that imports `@lunora/storage` but never reads `ctx.storage`, gated against a
   matrix rating `objectStorage: "unsupported"` → **zero** diagnostics.
2. The same app but reading `ctx.storage` → **one** `platform_unsupported_feature`
   diagnostic (the existing behaviour, now proven to be preserved).
3. The `mail` case from Step 1, asserting whichever behaviour you chose and documented.

And to `packages/codegen/__tests__/discover-feature-usage.test.ts`: an import-only source
sets `imported.storage` but not `contextRead.storage`.

**Verify**: `pnpm --filter "@lunora/codegen" run test` → all pass, including the 4 new cases.

## Test plan

- **Exemplar files**: `packages/codegen/__tests__/platform-target.test.ts` (gate
  behaviour against an explicit matrix — `gateAgainstMatrix` is exported precisely so it
  can be exercised against any matrix without the registry) and
  `packages/codegen/__tests__/discover-feature-usage.test.ts` (probe behaviour, writes
  real source files into a `mkdtempSync` workdir and runs a real ts-morph `Project`).
- 4 new cases as above.
- Golden fixtures unchanged — the strongest single assertion that emitted output did not move.

## Platform parity

This plan changes **when** a capability is gated, not what any target supports. It adds,
removes, and re-rates nothing in `PlatformCapabilities`; no `CAPABILITY_TO_FEATURE` entry
is added or removed.

| Feature                | `cloudflare` | `node`    | Notes                                                                                                                      |
| ---------------------- | ------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| all gated capabilities | unchanged    | unchanged | Ratings untouched. The gate's _input_ narrows from "import OR ctx read" to "ctx read"; a target's support set is the same. |

The user-visible effect on a non-Cloudflare target is strictly fewer false
`platform_unsupported_feature` errors. No app that genuinely reads a `ctx.*` surface
stops being gated.

## Done criteria

- [ ] `pnpm --filter "@lunora/codegen" run test` exits 0 with the 4 new cases
- [ ] `pnpm --filter "@lunora/codegen" run lint:types` exits 0
- [ ] `pnpm --filter "@lunora/codegen" run lint:eslint` exits 0
- [ ] `pnpm run api:check` exits 0
- [ ] `pnpm run build:packages` exits 0
- [ ] `git status --porcelain packages/codegen/__tests__/fixtures/` is empty
- [ ] `grep -n "featureUsage.images" packages/codegen/src/run-codegen.ts` still resolves
      to the import-inclusive signal (provisioning did not narrow)
- [ ] Both signals are built from `CAPABILITIES` (no hand-maintained key list):
      `grep -n "CAPABILITIES.map" packages/codegen/src/discover-feature-usage.ts` → 2 matches

## STOP conditions

- **STOP** if any golden fixture under `packages/codegen/__tests__/fixtures/` changes —
  emitted output must be byte-identical.
- **STOP** if the `mail` question (Step 1, detail 2) cannot be answered without changing
  `capabilities.ts`. That is a signal the split belongs in the table as a facet, which is
  a larger design than this plan authorises.
- **STOP** if threading the second signal requires changing more than the five source
  files in scope.
- **STOP** if any `has*` flag's truth value changes for any existing test app.

## Maintenance notes

- The two signals must both stay derived from `CAPABILITIES`. If a future edit
  hand-writes either key list, the "a capability added there is automatically probed
  here — the two can't drift" property in the module docblock stops being true.
- The next capability whose module ships a binding-free helper needs no change: that is
  the point of doing this for all capabilities rather than for `storage`.
- Reviewer: the single highest-value check is the fixture diff. Second is that
  `hasImages` still reads the import-inclusive signal — that is the flag most likely to
  be "cleaned up" into the narrow one by a later reader who does not know why it differs
  from `hasStorage`.
