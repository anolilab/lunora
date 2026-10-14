# Plan 435 design: The portability-budget leg of the platform conformance TCK

> Deliverable of plans/435-platform-budget-tck-spike.md. Design + inventory
> only — no code ships from this document. Drift check at `207be1b63` (HEAD):
> zero drift in `packages/platform/src`, `cloudflare-host.ts`,
> `node-socket-host.ts`; the "Current state" excerpts in the spike all verified
> against live code.

## Summary of the recommendation

Two budgets are documented in the contracts and enforced by exactly one host:
the socket tag count (≤ 9 usable) and tag length (≤ 256 chars). Move the
validation into `@lunora/platform` as a zero-dep helper that _reports_ a
violation (each adapter throws its own error type, so the Cloudflare adapter
keeps its catalogued `SOCKET_TAG_BUDGET_EXCEEDED` `LunoraError` without giving
the zero-dep contracts package an `@lunora/errors` edge), call it from all
three adapters (Cloudflare, Node, the `/conformance` reference host), and add
two refusal legs to the TCK's `SocketHost` section so no host can accept what
Cloudflare would refuse. Everything else numeric in the package is either
already engine-enforced (`WORKERD_SQLITE_LIMITS`) or genuinely advisory
(binding projections of Cloudflare-only services). One undocumented budget —
the attachment size Cloudflare's runtime caps — is the inventory's real
discovery and becomes a documentation fix, not an enforcement one.

## Step 1: Inventory of documented budgets

Contract files read end to end: `socket-host.ts` (192 lines), `shard-host.ts`
(144), `scheduler-host.ts` (124), `kv-store.ts` (70), `shard-directory.ts`
(136), plus `bindings.ts` (455) and `capabilities.ts` (304). Adapters grepped:
`packages/platform-cloudflare/src/`, `packages/platform-node/src/`,
`packages/platform/src/conformance/reference-host.ts`.

| #   | Budget                                                                                        | Value                                                                                                                                                                                                                                                                                                                       | Contract location                                                                                       | Enforced today by                                                                                                                                                                                                                                                                                                                                                         | Host-independent layer that could enforce                                                                   |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Socket accept-time tag **count**                                                              | ≤ 9 usable (Cloudflare's 10-tag cap minus 1 reserved identity slot)                                                                                                                                                                                                                                                         | `packages/platform/src/socket-host.ts:32-41` (module header), `:103-109` (`accept` doc)                 | **Cloudflare adapter only**: `assertWithinTagBudget`, `packages/platform-cloudflare/src/cloudflare-host.ts:401-425`, called at `:476`; own regression file `cloudflare-host.tag-budget.test.ts`. Node host checks nothing (`node-socket-host.ts:156-180` `accept`). Reference host checks nothing (`conformance/reference-host.ts:428-443` `accept` — only `assertOpen`). | **Contract helper** in `@lunora/platform`, called at every adapter's `accept`                               |
| 2   | Socket tag **length**                                                                         | ≤ 256 characters each                                                                                                                                                                                                                                                                                                       | same as row 1                                                                                           | same as row 1 (`cloudflare-host.ts:415-423`)                                                                                                                                                                                                                                                                                                                              | **Contract helper**, same call sites                                                                        |
| 3   | Socket **attachment size**                                                                    | **documented nowhere** — the contract promises "arbitrary JSON state" survives (`socket-host.ts:10-11`); Cloudflare's runtime caps `serializeAttachment` at 2 KiB per socket (needs verification against CF docs — no in-repo source states it; the adapter passes attachments through unchecked, `cloudflare-host.ts:489`) | — (absent from contract)                                                                                | **nobody** (Cloudflare's provider throws at runtime; Node/reference are unbounded)                                                                                                                                                                                                                                                                                        | Documentation first (see classification); enforcement would sit in the same contract helper if ever adopted |
| 4   | Analytics Engine data-point shape                                                             | ≤ 20 `blobs`, ≤ 20 `doubles`, exactly 1 `index`                                                                                                                                                                                                                                                                             | `packages/platform/src/bindings.ts:104-118` (`AnalyticsEngineDataPoint`)                                | **nobody in-repo** (the CF service enforces it server-side; behavior for over-cap writes needs verification against CF docs)                                                                                                                                                                                                                                              | `@lunora/bindings/analytics` facade (single consumer) — not the platform contracts                          |
| 5   | KV `expirationTtl` / `expiration` minimum                                                     | ≥ 60 seconds                                                                                                                                                                                                                                                                                                                | `packages/platform/src/bindings.ts:142-145` (`KvGetOptions` cacheTtl), `:184` (`KvNamespacePutOptions`) | **nobody in-repo** ("Forwarded verbatim", `bindings.ts:145`; the CF service rejects — needs verification against CF docs). `packages/platform-node/src/node-kv-store.ts` implements `ShardKvStore`, not `KVNamespaceLike`, so no Node emulation currently accepts what CF refuses — re-verify in the build plan if a Node `KVNamespaceLike` lands                         | `@lunora/bindings/kv` facade — not the platform contracts                                                   |
| 6   | workerd SQLite caps (bound params 100, compound SELECT 5, LIKE pattern 50 B, SQL text 100 KB) | see values                                                                                                                                                                                                                                                                                                                  | not in `@lunora/platform` — `packages/shard-engine/src/drizzle.ts:38-47` (`WORKERD_SQLITE_LIMITS`)      | **engine, on every host**: `do-exec.ts:37-51` refuses over-limit SQL before any host executor sees it; `ctx-db-companions.ts:253` consumes the same constants                                                                                                                                                                                                             | already done — this is the precedent, not a gap                                                             |

No other numeric commitment exists in the five contract files:
`shard-host.ts`, `scheduler-host.ts`, `kv-store.ts`, and `shard-directory.ts`
document behavioral guarantees (single-writer, at-least-once, exact prefix
enumeration, deterministic placement) with no caps. The
`capabilities.ts:18` "limited to 1000 sockets" string is an example inside a
doc comment for the free-text `notes` field, not a budget. STOP-condition
check: the contracts document ≥ 2 budgets (rows 1-2), so the premise holds.

## Step 2: Classification

| #   | Classification                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Contract-enforced**                   | The contract text already promises loud failure "on the host that enforces it" — the fix is making that every host, exactly the drift class the platform-parity policy exists for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | **Contract-enforced**                   | Same clause, same helper, same call sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | **Advisory, after a documentation fix** | First: the contract must stop promising "arbitrary" state — add a "Reserved-slot budget"-style paragraph citing the provider cap (with the verified number and a dated doc link, mirroring `cloudflare-host.ts:100-107`'s convention). Enforcement is _not_ recommended: the check would need to serialize/measure every attachment on the accept and re-attach paths — `SocketHandle.serializeAttachment` is engine-hot (`socket-host.ts:53-59` documents nanosecond sensitivities on adjacent paths) — and the engine's own attachments are small by construction. Document the ceiling; let Cloudflare's loud provider throw stay the enforcement. |
| 4   | **Advisory**                            | AE is a Cloudflare-only service surfaced through a pass-through projection ("the SHIPPING shapes, promoted from the packages that use them", `index.ts:33-36`); there is no second host that could drift, and refusal belongs — if it ever bites — in the single `@lunora/bindings/analytics` facade, not in the zero-dep contracts.                                                                                                                                                                                                                                                                                                                  |
| 5   | **Advisory**                            | Same shape as row 4: a verbatim-forwarded option of a CF service with no in-repo second implementation today. Becomes a real drift hazard only if a Node `KVNamespaceLike` emulation lands; the build plan for _that_ host should add the check to the facade then.                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | **Engine-enforced (done)**              | Noted and moved on, per the spike.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Step 3: Helper design

### Where it lives

In `packages/platform/src/socket-host.ts`, directly under the "Reserved-slot
budget" prose it enforces — the doc and the numbers stop being able to drift
apart. The package already exports runtime code (`resolveShard`,
`NOOP_EXECUTION_CONTEXT`), so "types and capability metadata only — near-zero
runtime code" (`index.ts:6`) admits it; zero dependencies are preserved.

### Why report-don't-throw

`@lunora/platform` cannot import `LunoraError` (zero-dep is a hard constraint,
and `@lunora/errors`' `isLunoraError` guard requires the real shape —
`type === "VisulimaError"` + string `code` + numeric `status`,
`packages/errors/src/guards.ts:32-40` — so a plain `Error` minted in platform
would silently downgrade the Cloudflare adapter's coded
`SOCKET_TAG_BUDGET_EXCEEDED` error, which already lives in
`packages/errors/src/catalog.ts`, to an internal fault at the RPC edge). The
helper therefore _finds_ the violation; each adapter throws in its own error
vocabulary — two lines per adapter.

### Signatures

```ts
// packages/platform/src/socket-host.ts (new, exported from the root barrel)

/**
 * The portable accept-time tag budget every host must refuse beyond.
 * 9 = Cloudflare's documented 10-tag `acceptWebSocket` cap minus the one
 * identity slot its adapter reserves; 256 = Cloudflare's per-tag character
 * cap. Verified against
 * developers.cloudflare.com/durable-objects/api/state/ (2026-08-01) — the
 * dated-verification convention moves here from `cloudflare-host.ts:100-107`.
 */
export const SOCKET_TAG_BUDGET = {
    maxTagLength: 256,
    usableTags: 9,
} as const;

/**
 * Check `tags` against {@link SOCKET_TAG_BUDGET}. Returns a human-readable
 * violation message, or `undefined` when within budget. Hosts call this at
 * the top of `accept` and throw their own error type on a violation, so an
 * over-budget call fails identically on every host instead of only on the
 * host whose provider enforces the cap.
 */
export const findSocketTagBudgetViolation = (tags?: ReadonlyArray<string>): string | undefined => {
    /* count check, then length check, as
    cloudflare-host.ts:401-425 does today */
};
```

### Adapter migration

- **`platform-cloudflare/src/cloudflare-host.ts`**: delete
  `assertWithinTagBudget`, `MAX_ACCEPT_TAGS`, `MAX_TAG_LENGTH`,
  `RESERVED_ID_TAG_COUNT` and the `:100-107` constants block (the dated
  verification comment moves to platform); `accept` (`:476`) becomes
  `const violation = findSocketTagBudgetViolation(tags); if (violation !== undefined) throw new LunoraError("SOCKET_TAG_BUDGET_EXCEEDED", violation);`.
  The existing `cloudflare-host.tag-budget.test.ts` regression file stays and
  keeps passing (message wording may need its assertions loosened to the
  shared message — the build plan should prefer adjusting the test to
  match-by-code, which is what it should have asserted anyway).
- **`platform-node/src/node-socket-host.ts`**: same two lines at the top of
  `accept` (`:156-180`), throwing whatever error type that host uses for
  caller errors (it has `@lunora/errors` available if a coded error is
  preferred — the build plan picks one and says so).
- **`platform/src/conformance/reference-host.ts`**: same check at `accept`
  (`:428`), throwing a plain `Error` per that file's existing convention
  (`assertOpen`, `:60-66`). Yes, the reference host needs it — it is the host
  the pure TCK runs against, so without it the new legs fail on the reference
  implementation itself.

## Step 3 (cont.): New TCK legs

Both extend the existing `describe("SocketHost")` section
(`packages/platform/src/conformance/suite.ts:249`), placed directly after
`it("accepts the portable budget of nine caller tags")` (`:387`) so the
floor-and-ceiling pair reads as one story. Assertions are host-neutral:
`expect(() => accept(...)).toThrow()` plus a post-refusal
`getSockets()` check — the suite cannot assert an error class because hosts
throw their own types (see helper design).

```ts
// "a regression fence AND a bug reproduction": passes only once every host
// refuses, which is the ceiling the nine-tag leg deliberately does not prove
// (suite.ts:378-386).
it("rejects a tenth caller tag on every host", async () => {
    // accept with Array.from({ length: 10 }) tags → toThrow();
    // then getSockets() does not contain a half-accepted socket.
});

it("rejects an over-length tag on every host", async () => {
    // accept with ["x".repeat(257)] → toThrow(); same post-condition.
});
```

The nine-tag floor leg (`:387`) is untouched — floor and ceiling are different
regressions (its own comment explains the reserved-slot drift it fences).
Both new legs run in the workerd-safe pure suite (they need no `node:sqlite`),
so they land in `suite.ts`, not the barrel.

## Migration notes for `platform-node` and TCK doubles

- `platform-node`'s conformance run inherits the legs automatically (its
  `conformance/` wires the shared suite); the only code change is the `accept`
  guard above. **Behavior change**: a Node-host caller passing 10+ tags or a
  257-char tag today succeeds and will refuse after this — that is the
  point, but the follow-up plan's risk section must say it (the spike's
  maintenance note already requires this).
- Any test double that implements `SocketHost.accept` without the helper and
  is run through the TCK will now fail the new legs — that is the TCK doing
  its job. Doubles not run through the TCK are unaffected (the contract type
  itself does not change).
- `@lunora/do` / shard-engine callers are unaffected: the engine already
  stays within budget (the nine-tag leg passing on Cloudflare today proves the
  budget is the live ceiling).

## API snapshot

`api-snapshots/platform.api.md` gains two root exports
(`SOCKET_TAG_BUDGET`, `findSocketTagBudgetViolation`). Standard flow: fresh
`pnpm run build:packages` first, then `pnpm run api:update` (the snapshot
reads `dist/` — stale-build snapshots are a known trap), commit the snapshot
move in the same PR. `@lunora/platform` is snapshot-gated at the stable tier,
so the addition is additive-only — no existing surface moves. The Cloudflare
package's snapshot loses nothing (its helper was module-local, never
exported).

## Open questions for the maintainer

1. **Is refusing 10+ tags on the Node host a breaking change for any current
   user?** Recommended answer: treat as non-breaking in practice —
   `@lunora/platform-node` is experimental-tier (ROADMAP-gated, no SemVer
   promise, per its snapshot tier) and any code relying on >9 tags is already
   broken on the primary target; land on `alpha` with the behavior change
   named in the commit body.
2. **Does the reference `node:sqlite` host in `/conformance` need the same
   guard?** Recommended: yes (see adapter migration) — the pure suite runs
   against it, so the legs are unpassable without it.
3. **How does the `api:check` snapshot move?** Recommended: additive
   root-barrel exports, `api:update` after a fresh build, same PR (details
   above).
4. **Should the helper throw instead of report, for a one-call-site API?**
   Recommended: no — throwing from the zero-dep package either loses the
   catalogued error code or drags `@lunora/errors` into `@lunora/platform`;
   the two-line adapter throw preserves both constraints (rationale in
   "Why report-don't-throw").
5. **Should the attachment-size gap (inventory row 3) ship in the same
   follow-up?** Recommended: yes for the documentation paragraph (it is one
   comment block in `socket-host.ts`, with the number verified against CF
   docs first), no for enforcement (hot-path measurement cost, rationale in
   Step 2).
6. **Do rows 4-5 (AE caps, KV TTL minimum) get TCK legs?** Recommended: no —
   they are projections of Cloudflare-only services with no second in-repo
   implementation; a leg would assert provider behavior the TCK cannot
   observe. Revisit only when a second host emulates the binding.

## What the follow-up implementation plan inherits

One PR, branch `improve/wave22-platform`: (1) helper + constants + moved
verification comment in `platform/src/socket-host.ts` (+ barrel export);
(2) three adapter call sites (cloudflare, node, reference), deleting the
Cloudflare-local copy; (3) two TCK legs in `suite.ts`'s SocketHost section;
(4) attachment-size documentation paragraph (after verifying the number);
(5) `api:update` for the platform snapshot; (6) risk section covering the
platform-node behavior change. Gates: `pnpm --filter "@lunora/platform" run
test`, the platform-cloudflare and platform-node suites (all inherit the new
legs), `pnpm run api:check`, `pnpm run dist:check`.
