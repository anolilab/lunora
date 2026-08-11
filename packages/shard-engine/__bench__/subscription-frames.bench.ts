import { bench, describe } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { subscriptionFrames } from "../src/subscription-delivery";

/**
 * `subscriptionFrames` runs once per `(socket, subscription)` on every
 * write-flush that touches a live query's read tables — the hottest CPU on the
 * WebSocket fan-out path. It re-parses the previously-delivered snapshot,
 * indexes both lists by `_id`, fingerprints every row of the new result, then
 * renders the candidate frames and measures them.
 *
 * The cost scales with the LIST length, not with how much changed, and that
 * asymmetry is the thing to watch: a one-row edit to a 200-row list still pays a
 * 200-row diff, and it pays it again for every subscribed socket.
 *
 * The cases hold the list length fixed and vary the change ratio, so a
 * regression in either half is visible:
 *
 * - **1 of N changed** — the case the delta path exists for. Dominated by the
 * `JSON.parse` of the baseline plus N `JSON.stringify(encodeWire(row))`
 * fingerprints; one frame is rendered and wins.
 * - **half of N changed** — fingerprints unchanged, frame rendering scales up.
 * - **all of N changed** — every row renders a frame, and the measurement then
 * rejects them all in favour of the snapshot. This is the cost of *deciding*
 * not to use deltas, and it is the case the old row-count rule got wrong.
 * - **reordered** — survivors moved, so `survivorsKeepOrder` rejects before any
 * frame is built. The early-out must not cost a full diff.
 * - **not a list** — the paginated `{ page, isDone, continueCursor }` shape
 * `usePaginatedQuery` subscribes to. It fails the `Array.isArray` precondition
 * immediately, so every write re-sends the whole page as a snapshot; the bench
 * records what that rejection costs today.
 *
 * Pure functions over plain data — no DO, no socket, no SQLite.
 */

const row = (index: number, revision: number): Record<string, unknown> => {
    return {
        _creationTime: 1_700_000_000_000 + index,
        _id: `msg_${String(index).padStart(6, "0")}`,
        authorId: `user_${String(index % 50)}`,
        body: `message body number ${String(index)} — ${"lorem ipsum dolor sit amet ".repeat(4)}`,
        channelId: "channels:general",
        editedAt: revision,
    };
};

/** The frame envelope a real CDC-backed shard stamps, so the measurement is not free of it. */
const envelope = { cursorSuffix: `,"cursor":998877,"epoch":"epoch-0000-0000-0001"`, lastMutationId: 42, subId: "sub_12", table: "messages" };

/** A baseline list and a next list in which the first `changed` rows carry a new revision. */
const buildCase = (total: number, changed: number): { nextResult: Record<string, unknown>[]; previousJson: string } => {
    const previous = Array.from({ length: total }, (_, index) => row(index, 1));

    return {
        nextResult: previous.map((existing, index) => (index < changed ? row(index, 2) : existing)),
        previousJson: JSON.stringify(encodeWire(previous)),
    };
};

const LIST_LENGTH = 200;

describe("subscriptionFrames — change ratio", () => {
    for (const changed of [1, LIST_LENGTH / 2, LIST_LENGTH]) {
        const { nextResult, previousJson } = buildCase(LIST_LENGTH, changed);
        const snapshotJson = JSON.stringify(encodeWire(nextResult));

        bench(`${String(changed)} of ${String(LIST_LENGTH)} rows changed`, () => {
            subscriptionFrames({ ...envelope, nextResult, previousJson, snapshotJson });
        });
    }
});

describe("subscriptionFrames — snapshot fallbacks", () => {
    const { nextResult, previousJson } = buildCase(LIST_LENGTH, 0);
    const reordered = nextResult.toReversed();
    // Precomputed, like every other case: the production caller builds the
    // snapshot payload once before calling in (see `pushSubscriptionData`), so
    // encoding it inside the bench body would fold a full 200-row encode plus
    // stringify into the number and overstate what the early-out costs.
    const reorderedSnapshotJson = JSON.stringify(encodeWire(reordered));

    bench(`${String(LIST_LENGTH)} rows, survivors reordered → rejected`, () => {
        subscriptionFrames({ ...envelope, nextResult: reordered, previousJson, snapshotJson: reorderedSnapshotJson });
    });

    // The shape `.paginate()` returns, and therefore what every `usePaginatedQuery`
    // page subscribes to: an object wrapping the array, not the array itself.
    const paginatedNext = { continueCursor: "c_200", isDone: false, page: nextResult };
    const paginatedPreviousJson = JSON.stringify(encodeWire({ continueCursor: "c_200", isDone: false, page: JSON.parse(previousJson) }));
    const paginatedSnapshotJson = JSON.stringify(encodeWire(paginatedNext));

    bench(`paginated { page, isDone, continueCursor } → rejected (not an array)`, () => {
        subscriptionFrames({ ...envelope, nextResult: paginatedNext, previousJson: paginatedPreviousJson, snapshotJson: paginatedSnapshotJson });
    });
});
