import { describe, expect, it, vi } from "vitest";

import { EventLogDOClient } from "../src/event-log-do-client";
import { EventSource } from "../src/event-source";
import type { LocalMirror } from "../src/local-mirror";
import { isClientSeq, isGlobalSeq, isInputEvent } from "../src/seq";
import { subscribeToMirror } from "../src/subscribe-mirror";
import type { TableDiff } from "../src/table-diff";

// ── EventLogDOClient — wire contract + error handling ────────────────────

describe("eventLogDOClient wire contract", () => {
    const clientWith = (respond: (request: Request) => Response): { client: EventLogDOClient; requests: Request[] } => {
        const requests: Request[] = [];
        const client = new EventLogDOClient({
            fetch: async (request) => {
                requests.push(request);

                return respond(request);
            },
        });

        return { client, requests };
    };

    it("append POSTs the events as JSON to /append", async () => {
        expect.assertions(4);

        const { client, requests } = clientWith(() => Response.json({ entries: [{ payload: { n: 1 }, seq: 0, timestamp: 1, type: "a" }] }));

        const entries = await client.append([{ payload: { n: 1 }, type: "a" }]);

        expect(entries).toHaveLength(1);
        expect(requests[0]?.method).toBe("POST");
        expect(new URL(requests[0]?.url as string).pathname).toBe("/append");
        await expect(requests[0]?.json()).resolves.toStrictEqual({ events: [{ payload: { n: 1 }, type: "a" }] });
    });

    it("getSince encodes its cursor and limit in the query string", async () => {
        expect.assertions(2);

        const { client, requests } = clientWith(() => Response.json({ entries: [], truncated: false }));

        await client.getSince(7);
        await client.getSince(3, 25);

        // No `limit` → the DO's own default page size applies.
        expect(new URL(requests[0]?.url as string).search).toBe("?seq=7");
        expect(new URL(requests[1]?.url as string).search).toBe("?seq=3&limit=25");
    });

    it("surfaces the DO's structured error message on a non-OK response", async () => {
        expect.assertions(4);

        const { client } = clientWith(() => Response.json({ error: { code: "BAD_REQUEST", message: "events[] required" } }, { status: 400 }));

        await expect(client.append([])).rejects.toThrow("EventLogDO.append failed (400): events[] required");
        await expect(client.getSince(0)).rejects.toThrow("EventLogDO.getSince failed (400): events[] required");
        await expect(client.getSize()).rejects.toThrow("EventLogDO.getSize failed (400): events[] required");
        await expect(client.getState()).rejects.toThrow("EventLogDO.getState failed (400): events[] required");
    });

    it("falls back to the status text when the error body is not JSON", async () => {
        expect.assertions(1);

        const { client } = clientWith(() => new Response("<html>upstream exploded</html>", { status: 502, statusText: "Bad Gateway" }));

        await expect(client.getSize()).rejects.toThrow("EventLogDO.getSize failed (502): Bad Gateway");
    });

    it("falls back to the status text when the error body has no message", async () => {
        expect.assertions(1);

        const { client } = clientWith(() => Response.json({ error: { code: "INTERNAL" } }, { status: 500, statusText: "Internal Server Error" }));

        await expect(client.getState()).rejects.toThrow("EventLogDO.getState failed (500): Internal Server Error");
    });
});

// ── Seq guards ────────────────────────────────────────────────────────────

describe("seq guards", () => {
    it("isGlobalSeq narrows numbers only", () => {
        expect.assertions(3);
        expect(isGlobalSeq(0)).toBe(true);
        expect(isGlobalSeq(42)).toBe(true);
        expect(isGlobalSeq({ client: 1, global: 0, rebaseGeneration: 0 })).toBe(false);
    });

    it("isClientSeq requires the rebaseGeneration marker", () => {
        expect.assertions(2);
        expect(isClientSeq({ client: 1, global: 0, rebaseGeneration: 2 })).toBe(true);
        expect(isClientSeq(5)).toBe(false);
    });

    it("isInputEvent accepts seq-less events and rejects near-misses", () => {
        expect.assertions(8);
        expect(isInputEvent({ payload: { x: 1 }, timestamp: 100, type: "chat.messageSent" })).toBe(true);

        expect(isInputEvent(undefined)).toBe(false);

        expect(isInputEvent(null)).toBe(false);
        expect(isInputEvent("chat.messageSent")).toBe(false);
        expect(isInputEvent({ payload: {}, timestamp: 100 })).toBe(false); // no type
        expect(isInputEvent({ timestamp: 100, type: "x" })).toBe(false); // no payload
        expect(isInputEvent({ payload: {}, type: "x" })).toBe(false); // no timestamp
        expect(isInputEvent({ payload: {}, timestamp: 100, type: 42 })).toBe(false); // non-string type
    });
});

// ── EventSource — apply-time reducer errors + events() lifecycle ─────────

describe("eventSource edge paths", () => {
    it("applyEvent emits replay-error and keeps state when the reducer throws", () => {
        expect.assertions(6);

        const source = new EventSource({ count: 0 }, (state, entry) => {
            if (entry.type === "boom") {
                throw new Error("reducer exploded");
            }

            return entry.type === "inc" ? { count: state.count + 1 } : state;
        });

        const errors: Error[] = [];
        const stateChanges: unknown[] = [];

        source.emitter.on("replay-error", ({ error }) => errors.push(error));
        source.emitter.on("state-changed", ({ state }) => stateChanges.push(state));

        source.applyEvent("inc", null);

        // REPLICA-07: a throwing reducer must not leave a logged entry that
        // state never reflected, AND must not report the uncommitted
        // candidate back to the caller as if it were a successfully
        // persisted entry (its `seq` is free to be reused by the next
        // event) — so `applyEvent` rethrows instead of returning it.
        expect(() => source.applyEvent("boom", null)).toThrow("reducer exploded");

        expect(source.state).toStrictEqual({ count: 1 });
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toBe("reducer exploded");
        // The bad event produced no state-changed emission.
        expect(stateChanges).toStrictEqual([{ count: 1 }]);
        // The log commits an entry only AFTER the reducer succeeds — the
        // "boom" entry was never appended.
        expect(source.log.size).toBe(1);
    });

    it("events() returns immediately for an already-aborted signal", async () => {
        expect.assertions(1);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);

        const controller = new AbortController();

        controller.abort();

        const iterator = source.events(controller.signal);

        await expect(iterator.next()).resolves.toStrictEqual({ done: true, value: undefined });
    });

    it("events() wakes an idle iterator when a new event arrives", async () => {
        expect.assertions(3);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        // No past entries: the iterator parks in the phase-2 wait.
        const iterator = source.events();
        const pending = iterator.next();

        source.applyEvent("inc", null);

        const first = await pending;

        expect(first.done).toBe(false);
        expect(first.value?.type).toBe("inc");

        // Closing the generator runs its cleanup (unsubscribes the listener).
        await iterator.return(undefined);

        source.applyEvent("inc", null);

        expect(source.state).toStrictEqual({ count: 2 });
    });

    it("plan 284: abort while idle settles the pending next() promise", async () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);

        const controller = new AbortController();
        const iterator = source.events(controller.signal);

        // Drain the one past entry so the generator parks in the phase-2 idle wait.
        const first = await iterator.next();

        expect(first).toStrictEqual({ done: false, value: expect.objectContaining({ type: "inc" }) });

        const pending = iterator.next();

        controller.abort();

        // Race against a real-timer sentinel: pre-fix, `pending` never settles
        // (the idle park is resolved only by the state-changed listener, which
        // an abort never fires), so the sentinel wins and this assertion fails
        // by mismatch rather than the test wedging vitest.
        const TIMEOUT = Symbol("timeout");
        const sentinel = new Promise((resolve) => {
            setTimeout(resolve, 200, TIMEOUT);
        });

        const settled = await Promise.race([pending, sentinel]);

        expect(settled).toStrictEqual({ done: true, value: undefined });
    });

    it("plan 284: abort tears down the state-changed listener (no leaked listener/buffer)", async () => {
        expect.assertions(3);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));
        const offSpy = vi.spyOn(source.emitter, "off");

        const controller = new AbortController();
        const iterator = source.events(controller.signal);

        // No past entries: the generator parks immediately in phase 2.
        const pending = iterator.next();

        controller.abort();

        await expect(pending).resolves.toStrictEqual({ done: true, value: undefined });

        // The generator's `finally` must have unsubscribed the state-changed
        // listener it registered in `events()` — pre-fix, `unsub()` never runs
        // because the generator never reaches its `finally` (the pending
        // `next()` above would hang, which the previous test already pins).
        expect(offSpy).toHaveBeenCalledWith("state-changed", expect.any(Function));

        // Indirect corroboration: applying another event afterward is picked
        // up by a fresh, independent events() generator exactly once — the
        // aborted generator's (leaked, pre-fix) listener would otherwise still
        // be registered alongside it, but that isn't observable here except
        // via the direct off() assertion above.
        source.applyEvent("inc", null);

        const second = source.events();
        const next = await second.next();

        expect(next).toStrictEqual({ done: false, value: expect.objectContaining({ type: "inc" }) });

        await second.return(undefined);
    });

    it("plan 284: no duplicate seq is yielded across the phase-1/phase-2 boundary when an event is applied mid-replay", async () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        // Two past entries so the generator suspends at a `yield` mid-way
        // through phase 1's replay, with more of the snapshotted batch still
        // to come.
        source.applyEvent("inc", null);
        source.applyEvent("inc", null);

        const iterator = source.events();
        const seqs: number[] = [];

        // First past entry.
        const firstResult = await iterator.next();

        seqs.push(firstResult.value!.seq);

        // Suspended between the two past entries' yields — apply a THIRD event
        // now, before resuming. If phase 1's own `getSince` snapshot were
        // re-read after this point, this entry could be yielded twice (once
        // from the snapshot, once from the listener's buffer); if the
        // snapshot is fixed at fetch time, it can only ever be yielded once,
        // via the buffer, in phase 2.
        source.applyEvent("inc", null);

        // Second past entry (from the original 2-entry snapshot).
        const secondResult = await iterator.next();

        seqs.push(secondResult.value!.seq);

        // The third (mid-replay) event, via phase 2's buffer.
        const thirdResult = await iterator.next();

        seqs.push(thirdResult.value!.seq);

        expect(seqs).toStrictEqual([...new Set(seqs)]);
        expect(seqs).toHaveLength(3);

        await iterator.return(undefined);
    });
});

// ── subscribeToMirror — full-snapshot reconciliation ─────────────────────

interface MirrorDouble {
    applied: TableDiff[];
    mirror: LocalMirror;
    registered: string[];
}

const mirrorDouble = (primaryKey: string = "id"): MirrorDouble => {
    const applied: TableDiff[] = [];
    const registered: string[] = [];

    const mirror = {
        applyDiff: (diff: TableDiff) => {
            applied.push(diff);
        },
        onChange: () => () => undefined,
        primaryKeyOf: () => primaryKey,
        registerTable: (name: string) => {
            registered.push(name);
        },
    } as unknown as LocalMirror;

    return { applied, mirror, registered };
};

describe(subscribeToMirror, () => {
    const functionRef = { __lunoraRef: "todos/list" };

    const wire = (primaryKey?: string): { double: MirrorDouble; push: (data: unknown) => void; unsubscribe: () => void; unsubscribed: () => boolean } => {
        const double = mirrorDouble(primaryKey);
        let callback: ((data: unknown) => void) | undefined;
        let torn = false;

        const client = {
            subscribe: (_reference: { __lunoraRef: string }, _arguments: Record<string, unknown>, onData: (data: unknown) => void) => {
                callback = onData;

                return () => {
                    torn = true;
                };
            },
        };

        const unsubscribe = subscribeToMirror(client, double.mirror, functionRef, {});

        return {
            double,
            push: (data) => callback?.(data),
            unsubscribe,
            unsubscribed: () => torn,
        };
    };

    it("derives the mirror table from the function ref and registers it", () => {
        expect.assertions(1);

        const { double } = wire();

        expect(double.registered).toStrictEqual(["fn_todos_list"]);
    });

    it("upserts every row of the first frame and only the changes of the next", () => {
        expect.assertions(4);

        const { double, push } = wire();

        push([
            { id: "1", title: "a" },
            { id: "2", title: "b" },
        ]);

        expect(double.applied).toHaveLength(1);
        expect(double.applied[0]?.table).toBe("fn_todos_list");
        expect(double.applied[0]?.changes).toStrictEqual([
            { data: { id: "1", title: "a" }, type: "insert" },
            { data: { id: "2", title: "b" }, type: "insert" },
        ]);

        // Row "1" vanished from the server result — the snapshot pass deletes
        // it. Row "2" is byte-identical to the previous frame, so it is NOT
        // re-upserted.
        push([{ id: "2", title: "b" }]);

        expect(double.applied[1]?.changes).toStrictEqual([{ id: "1", type: "delete" }]);
    });

    it("emits nothing for a frame identical to the last one", () => {
        expect.assertions(2);

        const { double, push } = wire();

        const rows = [
            { id: "1", title: "a" },
            { id: "2", title: "b" },
        ];

        push(rows);
        // Same rows, fresh objects, keys in a different order — same content.
        push([
            { title: "b", id: "2" },
            { title: "a", id: "1" },
        ]);
        push(rows);

        expect(double.applied).toHaveLength(1);

        // …and a real edit still lands.
        push([
            { id: "1", title: "a" },
            { id: "2", title: "B!" },
        ]);

        expect(double.applied[1]?.changes).toStrictEqual([{ data: { id: "2", title: "B!" }, type: "insert" }]);
    });

    it("diffs on the table's registered primary key, not a hard-coded `id`", () => {
        expect.assertions(2);

        // `registerTable(name, {})` must not erase a caller-supplied
        // `primaryKey`; the mirror keeps answering `todoId` and the snapshot
        // pass keys rows by it.
        const { double, push } = wire("todoId");

        push([{ title: "a", todoId: "t1" }]);
        push([{ title: "a", todoId: "t1" }]);

        expect(double.applied).toHaveLength(1);

        push([]);

        expect(double.applied[1]?.changes).toStrictEqual([{ id: "t1", type: "delete" }]);
    });

    it("tracks a bigint primary key like any other id", () => {
        expect.assertions(3);

        // An int64 column decodes off the wire as a `bigint`. Classified as
        // un-keyed it was inserted every frame and never deleted.
        const { double, push } = wire();

        push([{ id: 1n, title: "a" }]);

        expect(double.applied[0]?.changes).toStrictEqual([{ data: { id: 1n, title: "a" }, type: "insert" }]);

        // Identical frame: no re-upsert.
        push([{ id: 1n, title: "a" }]);

        expect(double.applied).toHaveLength(1);

        // …and the row is deletable once the server drops it.
        push([]);

        expect(double.applied[1]?.changes).toStrictEqual([{ id: "1", type: "delete" }]);
    });

    it("reconciles a frame that repeats a primary key against its LAST row", () => {
        expect.assertions(3);

        const { double, push } = wire();

        push([{ id: "1", title: "b" }]);

        expect(double.applied[0]?.changes).toStrictEqual([{ data: { id: "1", title: "b" }, type: "insert" }]);

        // The server repeats key "1", and the LAST of the two matches what the
        // mirror already holds. Diffing row by row queued the first ("a" differs
        // from the held "b") and then skipped the second ("b" matches), leaving
        // the mirror on "a" while the recorded frame said "b" — a divergence no
        // later frame could correct, because every subsequent frame of "b" looks
        // unchanged.
        push([
            { id: "1", title: "a" },
            { id: "1", title: "b" },
        ]);

        expect(double.applied).toHaveLength(1);

        // The recorded frame really is the last row, so a genuine edit still lands.
        push([{ id: "1", title: "c" }]);

        expect(double.applied[1]?.changes).toStrictEqual([{ data: { id: "1", title: "c" }, type: "insert" }]);
    });

    it("upserts a repeated primary key once, from its last row", () => {
        expect.assertions(1);

        const { double, push } = wire();

        push([
            { id: "1", title: "first" },
            { id: "2", title: "other" },
            { id: "1", title: "last" },
        ]);

        expect(double.applied[0]?.changes).toStrictEqual([
            { data: { id: "1", title: "last" }, type: "insert" },
            { data: { id: "2", title: "other" }, type: "insert" },
        ]);
    });

    it("treats a single-object frame as one row and numeric ids as strings", () => {
        expect.assertions(2);

        const { double, push } = wire();

        push({ id: 7, title: "solo" });

        expect(double.applied[0]?.changes).toStrictEqual([{ data: { id: 7, title: "solo" }, type: "insert" }]);

        // The numeric id was tracked — an empty next frame deletes it by string key.
        push([]);

        expect(double.applied[1]?.changes).toStrictEqual([{ id: "7", type: "delete" }]);
    });

    it("ignores frames that produce no changes", () => {
        expect.assertions(1);

        const { double, push } = wire();

        // Scalar frames carry no rows; with nothing previously mirrored there
        // is nothing to delete either — applyDiff must not run.
        push("not-a-row");
        push([]);

        expect(double.applied).toStrictEqual([]);
    });

    it("keeps the ids of a frame whose apply threw, so their deletes are not orphaned", () => {
        expect.assertions(3);

        // `knownIds` used to advance BEFORE `applyDiff`. One throwing frame — the
        // id-less row the docstring warns about fails the `NOT NULL` insert — then
        // dropped the previous frame's ids while their rows were still in the
        // mirror, and nothing ever emitted those deletes again.
        const applied: TableDiff[] = [];
        let failNext = false;

        const mirror = {
            applyDiff: (diff: TableDiff) => {
                if (failNext) {
                    throw new Error("NOT NULL constraint failed: fn_todos_list.id");
                }

                applied.push(diff);
            },
            onChange: () => () => undefined,
            primaryKeyOf: () => "id",
            registerTable: () => undefined,
        } as unknown as LocalMirror;

        let callback: ((data: unknown) => void) | undefined;
        const client = {
            subscribe: (_reference: { __lunoraRef: string }, _arguments: Record<string, unknown>, onData: (data: unknown) => void) => {
                callback = onData;

                return () => undefined;
            },
        };

        subscribeToMirror(client, mirror, functionRef, {});

        callback?.([{ id: "1", title: "a" }]);

        expect(applied).toHaveLength(1);

        // A frame carrying an id-less row: the apply throws.
        failNext = true;

        expect(() => {
            callback?.([{ title: "no id" }]);
        }).toThrow(/NOT NULL/);

        // Next healthy frame drops row "1" — the delete must still be emitted.
        failNext = false;
        callback?.([]);

        expect(applied[1]?.changes).toStrictEqual([{ id: "1", type: "delete" }]);
    });

    it("tears down the underlying client subscription on unsubscribe", () => {
        expect.assertions(2);

        const { unsubscribe, unsubscribed } = wire();

        expect(unsubscribed()).toBe(false);

        unsubscribe();

        expect(unsubscribed()).toBe(true);
    });
});
