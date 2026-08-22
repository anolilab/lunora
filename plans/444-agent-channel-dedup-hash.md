# Plan 444: Hash the inbound-channel dedup instance id instead of truncating it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/agent/src/channels.ts packages/agent/__tests__/channels.test.ts`
> On any change, compare the "Current state" excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

The inbound-channel workflow dedup key is built by sanitizing the provider's delivery id (stripping every non-`[\w-]` character) and then `.slice(0, 60)`. Two distinct deliveries whose ids differ only in stripped punctuation or past position 60 collapse to one key — and because a duplicate-instance rejection is deliberately acked 200 ("already handled"), the second event's agent run silently never starts: no log line, no provider retry. GitHub/Discord ids are safely short today, but Slack `event_id`s and custom channels are not contractually bounded. Hashing preserves the full id's entropy in a fixed-length key.

## Current state

- `packages/agent/src/channels.ts:284-305`:
    ```ts
    // Sanitize the id alone (the `channel-` prefix is already instance-id-safe);
    // an id absent or reduced to empty by sanitization gives no dedup key.
    const sanitizedId = id === undefined ? "" : id.replaceAll(UNSAFE_INSTANCE_ID, "");

    if (sanitizedId === "") {
        await workflow.create({ params: run });
        return ack();
    }

    try {
        await workflow.create({ id: `${channel}-${sanitizedId}`.slice(0, 60), params: run });
    } catch (error) {
        if (isDuplicateInstanceError(error)) {
            return ack();
        }
        ...
    ```
- The repo's precedent for exactly this need — `packages/notify/src/subscriptions/normalize.ts:94-96`:
    ```ts
    * Algorithm lifted from `@lunora/replica`'s bit-verified `fnv1a64Hex`.
    const fnv1a64Hex = (input: string): string => {
    ```
    (module-private copy, ~15 lines, with the provenance comment). The verified original: `packages/replica/src/apply-diff.ts:92` (exported at `:287`, but importing `@lunora/replica` from `@lunora/agent` would add a dependency edge — copy, don't import, matching what notify did).
- Existing tests: `packages/agent/__tests__/channels.test.ts` (has dedup/id cases — read them before editing).

## Commands you will need

| Purpose    | Command                                         | Expected on success |
| ---------- | ----------------------------------------------- | ------------------- |
| Install    | `pnpm install`                                  | exit 0              |
| Build deps | `pnpm --filter "@lunora/agent..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/agent" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/agent" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/agent" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/agent/src/channels.ts`
- `packages/agent/__tests__/channels.test.ts`

**Out of scope**:

- `isDuplicateInstanceError` / the ack semantics — correct as designed.
- notify's and replica's copies of the hash.

## Git workflow

- Branch: shared wave branch `improve/wave22-agent`.
- Commit: `fix(agent): hash inbound-channel dedup ids, not truncate`

## Steps

### Step 1: Replace sanitize-then-slice with hash

Copy `fnv1a64Hex` from `packages/replica/src/apply-diff.ts:92` into `channels.ts` (module-private, with notify's provenance-comment style: "Algorithm lifted from `@lunora/replica`'s bit-verified `fnv1a64Hex`."). Hash the **raw** id (pre-sanitization — the hash output is `[0-9a-f]`, always instance-id-safe, so sanitization of the id becomes unnecessary; keep the `id === undefined || id === ""` no-dedup-key branch):

```ts
await workflow.create({ id: `${channel}-${fnv1a64Hex(id)}`, params: run });
```

Check `UNSAFE_INSTANCE_ID` has no other consumers in the file before removing the `sanitizedId` variable (`grep -n "UNSAFE_INSTANCE_ID\|sanitizedId" packages/agent/src/channels.ts`); if the channel prefix itself relies on prior validation, leave that untouched. Verify the resulting id length (`channel` prefix + 1 + 16 hex chars) stays within Cloudflare's 64-char instance-id limit for every channel name the module defines (grep the channel literals in the file).

Behavior note for the commit body: in-flight instances keyed under the old scheme will be re-created once under the new key; the duplicate-ack path tolerates this.

**Verify**: `pnpm --filter "@lunora/agent" run test -- channels` → suite passes (update any test asserting the old `${channel}-${sanitizedId}` literal — those encode the bug's shape, adjust to assert the hashed form).

### Step 2: Collision regression test

Add to `channels.test.ts`: two ids identical in their first 60 sanitized chars but differing after (e.g. 70-char ids with different tails) produce **different** workflow ids (assert via the `workflow.create` stub's received `id`s); and the same id delivered twice produces the same key (dedup still works).

**Verify**: `pnpm --filter "@lunora/agent" run test -- channels` → all pass including the 2 new cases.

## Test plan

As above, modeled on the existing dedup tests in `channels.test.ts`.

## Done criteria

- [ ] `grep -n "slice(0, 60)" packages/agent/src/channels.ts` → no match
- [ ] `pnpm --filter "@lunora/agent" run test` exits 0 with the new tests
- [ ] `pnpm --filter "@lunora/agent" run lint:types` exits 0

## STOP conditions

- The excerpts don't match the live code.
- Cloudflare's instance-id constraints (charset/length) reject the hashed form in the workflow stub's validation or documented limits — report with the constraint found.

## Maintenance notes

- Third copy of `fnv1a64Hex` in the repo (replica, notify, now agent) — if a fourth appears, promote it to `shared/` (zero-dep) and point all four at it.
