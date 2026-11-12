# Plan 588 — kv / storage / container keys count as scoped only when an identity value is composed in

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. A reviewer dispatched you and maintains
> `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 79b0c5a6a..HEAD -- packages/codegen/src/argument-taint.ts packages/codegen/src/discover/argument-derived-accesses.ts packages/codegen/src/discover/kv-key-accesses.ts packages/codegen/src/discover/storage-key-accesses.ts packages/codegen/src/discover/container-key-accesses.ts packages/codegen/src/discover/context-root.ts`
> Expected: only `argument-taint.ts` changed (by plan 583, which lands first on the same branch).

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** TODO
**Source:** row 50 of the 2026-11-11 audit (advisor lints). Same branch as plan 583 (lands after it).

## Status

- **Priority**: P1 · **Effort**: S–M · **Risk**: MED (widens two ERROR rules) · **Depends on**: plan 583 (same branch) · **Category**: bug (security-lint false negative)

## 0. Headline finding

`isScopedByContext` treats a key as server-scoped when it contains ANY `ctx.*` value, so
`ctx.kv.get(\`${ctx.env.PREFIX}/${args.key}\`)`or a key built from`ctx.now`and caller input is
treated as identity-scoped and`kv_unscoped_user_key_idor`/`storage_key_from_user_args` stay
silent. For these IDOR sinks only an identity value (`ctx.auth.*`) scopes a key to its caller.

## 1. Current state (audit)

- `packages/codegen/src/argument-taint.ts` — `isScopedByContext` (~line 284-320): true when the key
  `referencesContext`, or its trusted one-hop initializer does, or any identifier composed into it
  hops (via `trustedInitializerOf`) to something that `referencesContext`.
- `referencesContext` (`packages/codegen/src/discover/context-root.ts:436-440`) is true for any
  identifier whose `contextPathOf(identifier, "trust")` is defined — i.e. ANY ctx surface.
- `contextPathOf(node, policy)` (`context-root.ts:196`) returns the ctx path a member-access chain denotes
  (`ctx.auth.userId` → `["auth", "userId"]`, a destructured `auth` → `["auth"]`); it is NOT exported.
  Exported siblings: `contextSurfacePathOf` (discover policy), `isContextRooted`, `referencesContext`.
- Callers of `isScopedByContext`: `discover/argument-derived-accesses.ts:45` (shared by
  `kv-key-accesses.ts`, `storage-key-accesses.ts`, `container-key-accesses.ts`, `browser-url-accesses.ts`),
  `mail-recipient-accesses.ts:57,66`, `image-delivery-url-accesses.ts:29`, `ai-raw-runs.ts:46`,
  `ratelimit-key-selectors.ts:105`, `vector-namespace-accesses.ts:164`.
- The ctx identity surface: `packages/server/src/types.ts:1591` — `interface AuthState { getIdentity(); readonly userId }`,
  exposed as `ctx.auth` on query/mutation/action ctx (`types.ts:2549, 2639, 2748`); codegen also types
  `ctx.auth.identity.<claim>`. There is NO `ctx.identity` on the ctx object, so `auth` is the only identity root.
- `ArgumentDerivedAccessConfig` (`argument-derived-accesses.ts:~87`): `argIndex`, `matchReceiver`, `methods`, `requireUnmodifiedReach?`.

## 2. Design decisions

- **Narrow only the IDOR sinks** (kv, storage, container instance keys). Browser URLs, image
  delivery URLs, mail recipients, AI model names, rate-limit keys and vector namespaces keep
  `isScopedByContext`: for a URL, `${ctx.env.CDN}/${args.path}` pins the host and IS the safe
  shape, so identity-only scoping would be a false positive there.
- **Identity = a ctx path whose first segment is `auth`**, directly, through the trusted one-hop
  initializer, or through a composed local (`const uid = ctx.auth.userId; \`${uid}/${args.name}\``).
A value read from the database by the caller's own id (`const me = await ctx.db.users.get(ctx.auth.userId)`)
contains `ctx.auth` and still counts.
- **Not a prefix requirement.** Rejected alternative: require the identity to be the key's prefix.
  A key that ends in the user id (`${args.name}/${uid}`) is still unique to the caller, and a prefix
  rule would flag it.
- The choice is a config field `scope: "identity"` on `ArgumentDerivedAccessConfig` (default keeps
  today's `isScopedByContext`), set by the three IDOR feeders.

## 3. Steps

### Step 1: `isScopedByIdentity`

- In `context-root.ts`, export `contextTrustPathOf = (node) => contextPathOf(node, "trust")` (named export added to the export list).
- In `argument-taint.ts`, add `referencesIdentity(node)`: for `node` and each value identifier in it,
  take the outermost member chain rooted at that identifier (climb parents while the parent is a
  `PropertyAccessExpression`/`ElementAccessExpression`/`NonNullExpression` whose `getExpression()` is
  the current node), and return true when `contextTrustPathOf(chain)?.[0] === "auth"`.
- Add exported `isScopedByIdentity(node)`, the same three-stage shape as `isScopedByContext` but with
  `referencesIdentity` in place of `referencesContext`. JSDoc says why it exists (IDOR sinks) and why
  not the other sinks.

**Verify**: `pnpm --filter "@lunora/codegen" run lint:types` → exit 0.

### Step 2: wire the three IDOR feeders

- `ArgumentDerivedAccessConfig` gets `scope?: "context" | "identity"` (JSDoc: identity for IDOR sinks).
  In the shared walk use `config.scope === "identity" ? isScopedByIdentity(key) : isScopedByContext(key)`.
- Set `scope: "identity"` in `kv-key-accesses.ts`, `storage-key-accesses.ts`, `container-key-accesses.ts`.
  Do NOT set it in `browser-url-accesses.ts`.

### Step 3: tests (new shapes AND safe neighbours)

- `argument-taint.test.ts`, new `describe("isScopedByIdentity")`:
  true for ``SINK(`${ctx.auth.userId}/${args.k}`)``, `const uid = ctx.auth.userId;\nSINK(\`${uid}/${args.k}\`)`,
`const { userId } = ctx.auth;\nSINK(\`${userId}:${args.k}\`)`, `const me = await ctx.db.users.get(ctx.auth.userId);\nSINK(\`${me._id}/${args.k}\`)`;
false for `` SINK(`${ctx.env.PREFIX}/${args.k}`) ``, `` SINK(`${ctx.now}-${args.k}`) ``, `SINK(args.k)`.
- `kv-key-accesses.test.ts`: ``await ctx.kv.get(`${ctx.env.PREFIX}/${args.key}`)`` → one row (new);
  ``await ctx.kv.get(`${ctx.auth.userId}/${args.key}`)`` → none (safe neighbour).
- `storage-key-accesses.test.ts`: same pair against the storage sink the file already tests.
- `browser-url-accesses` (if a test file exists under `__tests__/discover/`): ``ctx.browser.<method used there>(`${ctx.env.ORIGIN}/${args.path}`)`` stays unflagged.

**Verify**: the four test files pass.

### Step 4: red without the fix

Commit (`fix(codegen): scope kv, storage and container keys by identity only`). Then restore
`argument-derived-accesses.ts` only from the parent commit (`git show HEAD~1:<path> > <path>`), run the kv
and storage tests and confirm the two new "one row" tests FAIL; `git checkout -- <path>`, re-run → pass.

### Step 5: gates

codegen `test`, `lint:eslint`, `lint:types` exit 0. If an unrelated codegen test fails, STOP and report.

## Scope

In scope: `packages/codegen/src/argument-taint.ts`, `…/discover/context-root.ts` (one export),
`…/discover/argument-derived-accesses.ts`, `…/discover/kv-key-accesses.ts`, `…/discover/storage-key-accesses.ts`,
`…/discover/container-key-accesses.ts`, `packages/codegen/__tests__/argument-taint.test.ts`,
`packages/codegen/__tests__/discover/{kv-key-accesses,storage-key-accesses,browser-url-accesses}.test.ts` (the last only if it exists).
Out of scope: mail, image, ai, ratelimit, vector feeders; every lint; every app.

## Done criteria

- [ ] codegen `test`, `lint:eslint`, `lint:types` exit 0
- [ ] new kv/storage "one row" tests fail without the feeder wiring
- [ ] `grep -n 'scope: "identity"' packages/codegen/src/discover/*.ts` → exactly 3 matches

## STOP conditions

- `contextPathOf` no longer exists or has a different signature.
- An unrelated codegen test fails.
- A verification fails twice.

## 6. Platform parity

Not applicable.

## Maintenance notes

- Rollout: `kv_unscoped_user_key_idor` (ERROR for public procedures) and `storage_key_from_user_args`
  newly fire on keys that compose `args` with a non-identity ctx value (`ctx.env.*`, `ctx.now`, …);
  `container_instance_key_from_user_input` likewise.
- If a second identity root is ever added to ctx (e.g. a tenant surface), add it to `referencesIdentity`.
