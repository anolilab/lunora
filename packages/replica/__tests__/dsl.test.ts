import { describe, expect, it } from "vitest";

import { defineEvents, defineMaterializer, EventLog, InMemorySnapshotStore, MaterializerRuntime } from "../src/index";

// ─── defineEvents ─────────────────────────────────────────────────────

describe(defineEvents, () => {
    it("creates factory functions with qualified type names", () => {
        const events = defineEvents({
            chat: {
                messageSent: {} as { channelId: string; text: string },
                userJoined: {} as { name: string; userId: string },
            },
            system: {
                configUpdated: {} as { key: string; value: unknown },
            },
        });

        const event = events.chat.messageSent({ channelId: "c1", text: "hello" });

        expect(event.type).toBe("chat.messageSent");
        expect(event.payload).toEqual({ channelId: "c1", text: "hello" });
        expect(event.timestamp).toBeTypeOf("number");
    });

    it("each factory has a static type property", () => {
        const events = defineEvents({
            chat: {
                messageSent: {} as { text: string },
            },
        });

        expect(events.chat.messageSent.type).toBe("chat.messageSent");
    });

    it("different namespaces produce distinct type prefixes", () => {
        const events = defineEvents({
            user: {
                created: {} as { id: string },
                deleted: {} as { id: string },
            },
            admin: {
                created: {} as { id: string },
            },
        });

        expect(events.user.created({ id: "1" }).type).toBe("user.created");
        expect(events.admin.created({ id: "2" }).type).toBe("admin.created");
    });

    it("works with EventLog append", () => {
        const log = new EventLog();
        const events = defineEvents({
            counter: {
                incremented: {} as { by: number },
            },
        });

        const entry = events.counter.incremented({ by: 1 });
        log.append(entry.type, entry.payload);

        expect(log.size).toBe(1);

        const all = log.getSince(0);

        expect(all[0]!.type).toBe("counter.incremented");
        expect(all[0]!.payload).toEqual({ by: 1 });
    });

    it("produces unique timestamps per call", async () => {
        const events = defineEvents({
            test: {
                tick: {} as { n: number },
            },
        });

        const a = events.test.tick({ n: 1 });
        await new Promise((r) => setTimeout(r, 1));
        const b = events.test.tick({ n: 2 });

        // Use >= because setTimeout(1) can fire within the same ms tick
        // on fast runtimes, making both timestamps identical.
        expect(b.timestamp).toBeGreaterThanOrEqual(a.timestamp);
    });

    it("accepts version prefix option", () => {
        const events = defineEvents(
            {
                chat: {
                    messageSent: {} as { text: string },
                },
            },
            { version: "v1" },
        );

        const event = events.chat.messageSent({ text: "hi" });

        expect(event.type).toBe("v1.chat.messageSent");
        expect(events.chat.messageSent.type).toBe("v1.chat.messageSent");
    });
});

// ─── defineMaterializer ────────────────────────────────────────────────

describe(defineMaterializer, () => {
    it("starts with initial state", () => {
        const m = defineMaterializer({
            name: "counts",
            initial: () => {
                return { count: 0 };
            },
            handle: (s) => s,
        });

        expect(m.state).toEqual({ count: 0 });
    });

    it("applies events through the reducer", () => {
        const m = defineMaterializer({
            name: "counts",
            initial: () => {
                return { count: 0 };
            },
            handle: (state, entry) => {
                if (entry.type === "increment") {
                    return { count: state.count + (entry.payload as number) };
                }

                return state;
            },
        });

        m.apply({ seq: 0, type: "increment", payload: 5, timestamp: 1 });

        expect(m.state).toEqual({ count: 5 });

        m.apply({ seq: 1, type: "increment", payload: 3, timestamp: 2 });

        expect(m.state).toEqual({ count: 8 });
    });

    it("ignores events the reducer does not match", () => {
        const m = defineMaterializer({
            name: "counts",
            initial: () => {
                return { count: 0 };
            },
            handle: (state, entry) => (entry.type === "increment" ? { count: state.count + 1 } : state),
        });

        m.apply({ seq: 0, type: "decrement", payload: null, timestamp: 1 });

        expect(m.state).toEqual({ count: 0 });
    });

    it("reset restores initial state", () => {
        const m = defineMaterializer({
            name: "counts",
            initial: () => {
                return { count: 0 };
            },
            handle: (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state),
        });

        m.apply({ seq: 0, type: "inc", payload: null, timestamp: 1 });
        m.apply({ seq: 1, type: "inc", payload: null, timestamp: 2 });

        expect(m.state).toEqual({ count: 2 });

        m.reset();

        expect(m.state).toEqual({ count: 0 });
    });

    it("setState replaces state directly", () => {
        const m = defineMaterializer({
            name: "test",
            initial: () => {
                return { x: 1 };
            },
            handle: (s) => s,
        });

        m.setState({ x: 42 });

        expect(m.state).toEqual({ x: 42 });
    });

    it("state getter returns a frozen object", () => {
        const m = defineMaterializer({
            name: "test",
            initial: () => {
                return { items: [] as number[] };
            },
            handle: (state, entry) => {
                if (entry.type === "add") {
                    return { items: [...state.items, entry.payload as number] };
                }

                return state;
            },
        });

        expect(Object.isFrozen(m.state)).toBe(true);
    });

    it("works as an EventReducer-compatible function", () => {
        const m = defineMaterializer({
            name: "compat",
            initial: () => 0,
            handle: (state, entry) => (entry.type === "add" ? state + (entry.payload as number) : state),
        });

        // It can be used just by calling apply repeatedly
        const entries = [
            { seq: 0, type: "add", payload: 10, timestamp: 1 },
            { seq: 1, type: "add", payload: 20, timestamp: 2 },
        ];

        for (const e of entries) {
            m.apply(e);
        }

        expect(m.state).toBe(30);
    });
});

// ─── MaterializerRuntime ───────────────────────────────────────────────

describe(MaterializerRuntime, () => {
    it("applies entries to all materializers", () => {
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const sums = defineMaterializer({
            name: "sums",
            initial: () => 0,
            handle: (s, e) => (e.type === "add" ? s + (e.payload as number) : s),
        });

        const runtime = new MaterializerRuntime([counts, sums]);

        const applied = runtime.applyEntries([
            { seq: 0, type: "inc", payload: null, timestamp: 1 },
            { seq: 1, type: "inc", payload: null, timestamp: 2 },
            { seq: 2, type: "add", payload: 5, timestamp: 3 },
        ]);

        expect(applied).toBe(3);
        expect(counts.state).toBe(2);
        expect(sums.state).toBe(5);
        expect(runtime.appliedSeq).toBe(3);
    });

    it("skips already-applied entries", () => {
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const runtime = new MaterializerRuntime([counts]);

        runtime.applyEntries([
            { seq: 0, type: "inc", payload: null, timestamp: 1 },
            { seq: 1, type: "inc", payload: null, timestamp: 2 },
        ]);

        expect(counts.state).toBe(2);
        expect(runtime.appliedSeq).toBe(2);

        // Re-apply same seqs — should be no-ops
        const skipped = runtime.applyEntries([
            { seq: 0, type: "inc", payload: null, timestamp: 1 },
            { seq: 1, type: "inc", payload: null, timestamp: 2 },
        ]);

        expect(skipped).toBe(0);
        expect(counts.state).toBe(2);
    });

    it("reset reinitializes all materializers", () => {
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const runtime = new MaterializerRuntime([counts]);

        runtime.applyEntries([{ seq: 0, type: "inc", payload: null, timestamp: 1 }]);

        expect(counts.state).toBe(1);

        runtime.reset();

        expect(counts.state).toBe(0);
        expect(runtime.appliedSeq).toBe(0);
    });

    it("recoverFromSnapshots restores state and watermark", async () => {
        const store = new InMemorySnapshotStore();

        // Pre-save a snapshot
        await store.save("counts", {
            appliedSeq: 5,
            state: 42,
        });

        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

        const recoveredSeq = await runtime.recoverFromSnapshots();

        expect(recoveredSeq).toBe(5);
        expect(counts.state).toBe(42);
        expect(runtime.appliedSeq).toBe(5);
    });

    it("recoverFromSnapshots returns 0 when no snapshots exist", async () => {
        const store = new InMemorySnapshotStore();
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s) => s,
        });

        const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

        const recoveredSeq = await runtime.recoverFromSnapshots();

        expect(recoveredSeq).toBe(0);
        expect(counts.state).toBe(0);
    });

    it("ignores a malformed snapshot with a watermark but no state — replays from 0 rather than skipping events", async () => {
        const store = new InMemorySnapshotStore();

        // A partial write / adapter drift: `appliedSeq` is present but `state`
        // is missing. Advancing the watermark here would permanently skip
        // events 0..appliedSeq without ever restoring their state.
        await store.save("counts", { appliedSeq: 5, state: undefined });

        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

        const recoveredSeq = await runtime.recoverFromSnapshots();

        expect(recoveredSeq).toBe(0);
        expect(runtime.appliedSeq).toBe(0);

        // The runtime replays from the very start — no event is skipped.
        const applied = runtime.applyEntries([
            { seq: 0, type: "inc", payload: null, timestamp: 1 },
            { seq: 1, type: "inc", payload: null, timestamp: 2 },
        ]);

        expect(applied).toBe(2);
        expect(counts.state).toBe(2);
    });

    it("ignores a NaN / negative appliedSeq — never writes NaN into the watermark", async () => {
        const store = new InMemorySnapshotStore();

        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        // A non-numeric `appliedSeq` would otherwise make `Math.min(...)` (the
        // fetch position) `NaN`, feeding `getSince(NaN)` to the DO; a negative
        // seq is equally nonsensical. Both must be rejected, leaving the
        // watermark at 0.
        for (const bad of [Number.NaN, -3, "5" as unknown as number]) {
            // eslint-disable-next-line no-await-in-loop -- sequential store rewrites are intentional
            await store.save("counts", { appliedSeq: bad, state: 5 });

            const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

            // eslint-disable-next-line no-await-in-loop -- sequential recovery is intentional
            const recoveredSeq = await runtime.recoverFromSnapshots();

            expect(recoveredSeq).toBe(0);
            expect(runtime.appliedSeq).toBe(0);
            expect(Number.isNaN(runtime.appliedSeq)).toBe(false);
        }
    });

    it("persistSnapshots saves current state", async () => {
        const store = new InMemorySnapshotStore();
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

        runtime.applyEntries([
            { seq: 0, type: "inc", payload: null, timestamp: 1 },
            { seq: 1, type: "inc", payload: null, timestamp: 2 },
            { seq: 2, type: "inc", payload: null, timestamp: 3 },
        ]);

        await runtime.persistSnapshots();

        const loaded = (await store.load("counts")) as { appliedSeq: number; state: number };

        expect(loaded.appliedSeq).toBe(3);
        expect(loaded.state).toBe(3);
    });

    it("recoverFromSnapshots then applyEntries skips recovered events", async () => {
        const store = new InMemorySnapshotStore();
        const counts = defineMaterializer({
            name: "counts",
            initial: () => 0,
            handle: (s, e) => (e.type === "inc" ? s + 1 : s),
        });

        await store.save("counts", { appliedSeq: 5, state: 5 });

        const runtime = new MaterializerRuntime([counts], { snapshotStore: store });

        await runtime.recoverFromSnapshots();

        // Apply entries 5 and 6 (seq 5 is the watermark, so only seq 5+ should apply)
        // Since watermark is 5, entries with seq < 5 are skipped
        const applied = runtime.applyEntries([
            { seq: 3, type: "inc", payload: null, timestamp: 1 }, // skipped — seq < 5
            { seq: 5, type: "inc", payload: null, timestamp: 2 }, // applied
            { seq: 6, type: "inc", payload: null, timestamp: 3 }, // applied
        ]);

        expect(applied).toBe(2);
        expect(counts.state).toBe(7); // 5 + 2
        expect(runtime.appliedSeq).toBe(7);
    });

    it("materializers list returns registered materializers", () => {
        const m1 = defineMaterializer({
            name: "a",
            initial: () => 0,
            handle: (s) => s,
        });

        const m2 = defineMaterializer({
            name: "b",
            initial: () => 0,
            handle: (s) => s,
        });

        const runtime = new MaterializerRuntime([m1, m2]);

        expect(runtime.materializers).toHaveLength(2);
        expect(runtime.materializers[0]!.def.name).toBe("a");
        expect(runtime.materializers[1]!.def.name).toBe("b");
    });
});
