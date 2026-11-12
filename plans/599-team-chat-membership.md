# Plan 599 — team-chat channels are membership-gated, checked in every procedure

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: branch `feat/improve-599-team-chat-membership` starts at the tip of
> `fix/improve-588-idor-identity-scope` (`598dad74b`). `git log --oneline -1` → `598dad74b`.

**Baseline:** `598dad74b` (2026-11-12)
**Status:** TODO
**Source:** follow-up to row 50 of the 2026-11-11 audit; owner decision (procedure-level checks, option 1).

## Status

- **Priority**: P2 · **Effort**: M–L · **Risk**: MED (example behaviour change, live queries) · **Depends on**: plan 588 branch · **Category**: feature (example)

## 0. Headline

`examples/team-chat` lets every signed-in user read and write every channel; its README lists private
channels as not included, and `messages.attachmentUrl` carries a suppression for the resulting
`storage_key_from_user_args` finding. This plan adds a membership model: every channel is
membership-gated, enforced in each procedure that reads or writes channel data, with join, leave and
a member list; then it removes the suppression.

## 1. Current state

- Schema `examples/team-chat/lunora/schema.ts`: `profiles` (`.global()`, `by_user` unique index), `channels`
  (root: `name`, `createdBy`, unique `by_name`), `messages` and `presence` (`.shardBy("channelId")`).
- `lunora/channels.ts`: `list` (signed-in → all channels), `create` (slugged, unique, inserts `{ createdBy, name }`).
- `lunora/messages.ts`: `list`, `search` (queries, return `[]` when signed out), `attachmentUrl` (action: reads
  `ctx.db.get("messages", messageId)`, signs `message.attachmentKey`; the line above the `return await
ctx.storage.getSignedUrl(...)` carries `// lunora-advisor-exempt storage_key_from_user_args -- …`), `send`
  (mutation), `requestAttachmentUpload` (action).
- `lunora/presence.ts`: `list` (query), `heartbeat`, `leave` (mutations), helper `ownPresence`.
- `src/server/index.ts:61`: `authorizeShard: ({ identity }) => Boolean(identity?.userId)`.
- Client: `src/client/App.tsx` (channel list / create / open), `src/client/Channel.tsx` (messages, presence, uploads).
- Tests: `examples/team-chat/__tests__/chat.test.ts` (vitest over the example's functions; read its harness first).
  e2e: `tests/e2e/examples-setup.ts:17` starts team-chat; find specs that drive it with
  `grep -rln "team-chat\|5275" tests/e2e`.
- README `examples/team-chat/README.md`: `authorizeShard` paragraph (~line 33) and "Not included" (~line 138).

## 2. Design decisions

- **All channels are membership-gated** (no public/private flag): the smaller change that makes the access rule true.
- **`channelMembers` table, `.global()`** (D1, like `profiles`): `{ channelId, userId, joinedAt }`, unique index
  `by_channel_user` on `["channelId", "userId"]`, plus `by_user` on `["userId"]`. Global because both the root-scoped
  `channels` procedures and every channel shard must read it.
- **`requireMember(ctx, channelId)`** in a new `lunora/membership.ts` (not an exported procedure): reads
  `ctx.db.channelMembers` with `where: { channelId, userId: ctx.auth.userId }` (identity-bound, so the advisor's
  scoping rule recognises it) and throws `LunoraError("FORBIDDEN", "join #… first")` when absent; throws
  `UNAUTHENTICATED` when signed out. Called first in `messages.list`, `messages.search`, `messages.send`,
  `messages.attachmentUrl` (after reading the message, with `message.channelId`), `messages.requestAttachmentUpload`,
  `presence.list`, `presence.heartbeat`, `presence.leave`.
- **Queries for signed-out callers** keep returning `[]` as today (the existing tests expect it); a signed-in non-member gets FORBIDDEN.
- **Discovery**: `channels.list` stays visible to every signed-in user and returns each channel with `isMember: boolean`
  (one `by_user` read of the caller's memberships), so a user can find channels to join.
- **Way in / out / see**: `channels.join({ channelId })`, `channels.leave({ channelId })` (removing the last member is
  allowed; the channel stays), `channels.members({ channelId })` (member-only; returns user ids + `joinedAt`).
  `channels.create` inserts the creator's membership in the same mutation.
- **`authorizeShard` stays "signed in"**; README states: the shard boundary admits any signed-in user; membership is
  enforced inside every procedure that reads or writes channel data; consequence: a signed-in non-member can still
  open a socket to a channel's shard and subscribe, but every query there refuses (FORBIDDEN) and every mutation refuses,
  so it receives no channel data.
- **Live queries**: a member who leaves must stop receiving updates. Verify whether a channel-shard subscription to
  `messages.list` re-runs when the global `channelMembers` row is deleted (the read is tracked or not). If it re-runs,
  the re-run refuses and the client shows "not a member". If it does NOT re-run, STOP and report (the fix — e.g. leave
  also writing a per-shard marker the queries read — is a design choice for the reviewer).
- **Seed / UI**: the client lists all channels with Join/Open; opening a channel requires membership; a Leave button and a
  member count in the channel header. If the example has seed data (`grep -rn seed examples/team-chat`), add memberships for it.
- **Suppression**: removed at the end; see Step 6.

## 3. Steps (one commit each)

1. Schema + `membership.ts` + `channels` changes (create adds membership; join/leave/members; list with `isMember`).
2. Gate the messages and presence procedures with `requireMember`.
3. Client: `App.tsx` / `Channel.tsx` flows (join, open, leave, members, forbidden state). Keep styles in `styles.css`.
4. Tests in `__tests__/chat.test.ts` (follow its harness): non-member cannot list/search/send/attach/presence (FORBIDDEN);
   join then can; leave then cannot; creator is a member; `members` lists the caller and is refused for non-members;
   `channels.list` marks `isMember`; existing tests updated only where they relied on open channels (join first) — list
   each in NOTES. Live query: subscribe as a member, leave, assert the subscription re-runs and refuses (use the harness's
   subscription API if it has one; if it has none, STOP and report).
   Red: with `requireMember` calls removed, the non-member tests FAIL.
5. README: replace the `authorizeShard` paragraph and the "Not included" entry per §2; document join/leave/members.
6. Remove the `// lunora-advisor-exempt storage_key_from_user_args …` line in `messages.ts`. Build the CLI closure
   (`pnpm --filter "lunorash..." run build`), run `(cd examples/team-chat && pnpm run codegen)` and check the output:
   it must show NO `storage_key_from_user_args` finding at `attachmentUrl` and NO `advisor_suppression_unused`.
   If `storage_key_from_user_args` IS reported there (the key comes from the message row, which the matcher does not see
   as dominated by `requireMember`), STOP: do not re-add the directive; restore the line (`git checkout -- examples/team-chat/lunora/messages.ts`
   is NOT enough if Step 2 changed that file — instead re-insert exactly the original directive line), and report the exact
   code shape of `attachmentUrl` and the finding's detail.
7. Regenerate the example (`pnpm run codegen` in `examples/team-chat`) and commit the `_generated` output separately;
   `pnpm run lint:eslint` in the example; e2e specs that open channels without joining: update them to join first (list them).

## Commands

| Purpose       | Command                                                                                 | Expected |
| ------------- | --------------------------------------------------------------------------------------- | -------- |
| Install       | `pnpm install --frozen-lockfile`                                                        | exit 0   |
| Build         | `pnpm --filter "lunorash..." run build`                                                 | exit 0   |
| Example tests | `pnpm --filter "<team-chat package name>" run test` (find the name in its package.json) | pass     |
| Example lint  | `(cd examples/team-chat && pnpm run lint:eslint)`                                       | exit 0   |

## Scope

In: `examples/team-chat/**` (lunora, src, **tests**, README, `_generated` via codegen only), e2e specs that drive team-chat.
Out: every package, other examples, the advisor matcher.

## STOP conditions

- Live queries do not re-run when membership changes (Step 4).
- The example's test harness cannot drive two users or a subscription.
- Step 6 still reports `storage_key_from_user_args` at `attachmentUrl`.
- A verification fails twice.

## 6. Platform parity

Not applicable (example code; no `ctx.*` surface added).

## 7. Revision after the executor's STOP (reviewer, 2026-11-12)

The executor stopped before any edit, correctly: (1) the example's test harness builds only shard tables
(`packages/shard-engine/src/ctx-db-migrations.ts:663,670` skip `.global()` tables; `chat.test.ts:11,194` already
note `profiles` is unreadable there), and (2) a channel shard's live query is NOT invalidated by a write to a `.global()`
row (`packages/shard-engine/src/dependency-tracker.ts:38-45`). A global membership table therefore can neither be tested
nor make a leave stop a subscription. Revised decisions (replace the matching bullets of §2):

- **`members` is shard-local**: `defineTable({ channelId, userId, joinedAt }).shardBy("channelId")` with unique index
  `by_channel_user` on `["channelId", "userId"]`. Every gate reads it inside the channel's own shard, so a `leave` (a write
  in that shard) re-runs that shard's subscriptions, which then refuse.
- **Discovery**: `channels.list` stays visible to every signed-in user and is unchanged (no `isMember`; reading per-channel
  membership from the root shard would be a fan-out). Opening a channel calls a new member-aware query
  `channels.membership({ channelId })` (in-shard, returns `{ isMember, memberCount }` for any signed-in user) to show
  Join or the channel.
- **join / leave / members** are channel-shard procedures (`shardKey: channelId`): `join` is idempotent; `leave` removes
  the caller's row; `members` is member-only.
- **Creator membership**: `channels.create` (root) schedules
  `ctx.scheduler.runAfter(0, internal.channels.addCreator, { channelId, userId }, { shardKey: <the new channel id> })`
  (an internal, idempotent insert), and the client also calls `channels.join` right after `create` so the creator can open the
  channel immediately. If the harness cannot run scheduled jobs, test `addCreator` directly and say so.
- `requireMember(ctx, channelId)` reads `ctx.db.members` with `where: { channelId, userId: ctx.auth.userId }`.
- Everything else in §2–§3 stands (gates, README wording, tests, live-query test, Step 6 directive removal with its STOP).
