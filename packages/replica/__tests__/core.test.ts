import { describe, expect, it, vi } from "vitest";

import type { EventLogEntry } from "../src/index";
import { EventEmitter, EventLog, EventSource, InMemorySnapshotStore, SubscriptionManager, UNHANDLED } from "../src/index";

// ─── EventEmitter ─────────────────────────────────────────────────────

describe(EventEmitter, () => {
    it("emits to registered handlers", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        emitter.on("test", (p) => calls.push(p));
        emitter.emit("test", "hello");

        expect(calls).toEqual(["hello"]);
    });

    it("off removes a handler", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        const handler = (p: string) => calls.push(p);
        emitter.on("test", handler);
        emitter.off("test", handler);
        emitter.emit("test", "hello");

        expect(calls).toEqual([]);
    });

    it("on returns an unsubscribe function", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        const unsub = emitter.on("test", (p) => calls.push(p));
        unsub();
        emitter.emit("test", "hello");

        expect(calls).toEqual([]);
    });

    it("emits to wildcard handlers", () => {
        expect.assertions(3);

        const emitter = new EventEmitter<{ a: number; b: string }>();
        const events: { event: string; payload: unknown }[] = [];

        emitter.onAny((event, payload) => events.push({ event: String(event), payload }));
        emitter.emit("a", 1);
        emitter.emit("b", "two");

        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({ event: "a", payload: 1 });
        expect(events[1]).toEqual({ event: "b", payload: "two" });
    });

    it("offAny removes a wildcard handler", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        const handler = (e: string, p: unknown) => calls.push(`${e}:${p}`);
        emitter.onAny(handler);
        emitter.offAny(handler);
        emitter.emit("test", "x");

        expect(calls).toEqual([]);
    });

    it("onAny returns an unsubscribe function", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        const unsub = emitter.onAny((e, p) => calls.push(`${e}:${p}`));
        unsub();
        emitter.emit("test", "x");

        expect(calls).toEqual([]);
    });

    it("continues after a handler throws", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ test: string }>();
        const calls: string[] = [];

        emitter.on("test", () => {
            throw new Error("boom");
        });
        emitter.on("test", (p) => calls.push(p));
        emitter.emit("test", "ok");

        expect(calls).toEqual(["ok"]);
    });

    it("hasListeners returns correct state", () => {
        expect.assertions(2);

        const emitter = new EventEmitter<{ a: number }>();

        expect(emitter.hasListeners("a")).toBe(false);

        emitter.on("a", () => {});

        expect(emitter.hasListeners("a")).toBe(true);
    });

    it("hasListeners returns true when wildcard listeners exist", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ a: number }>();

        emitter.onAny(() => {});

        expect(emitter.hasListeners("a")).toBe(true);
    });

    it("listenerCount returns the right count", () => {
        expect.assertions(2);

        const emitter = new EventEmitter<{ a: number }>();

        expect(emitter.listenerCount("a")).toBe(0);

        emitter.on("a", () => {});
        emitter.on("a", () => {});

        expect(emitter.listenerCount("a")).toBe(2);
    });

    it("clear removes all listeners", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ a: number }>();
        const calls: number[] = [];

        emitter.on("a", (p) => calls.push(p));
        emitter.onAny(() => calls.push(-1));
        emitter.clear();
        emitter.emit("a", 1);

        expect(calls).toEqual([]);
    });

    it("emit returns true when a handler was called", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ a: number }>();

        emitter.on("a", () => {});

        expect(emitter.emit("a", 1)).toBe(true);
    });

    it("emit returns false when no handler was called", () => {
        expect.assertions(1);

        const emitter = new EventEmitter<{ a: number }>();

        expect(emitter.emit("a", 1)).toBe(false);
    });
});

// ─── EventSource ──────────────────────────────────────────────────────

describe(EventSource, () => {
    it("starts with the initial state", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (s) => s);

        expect(source.state).toEqual({ count: 0 });
        expect(source.replayed).toBe(false);
    });

    it("applies events through the reducer", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => {
            if (entry.type === "increment") {
                return { count: state.count + (entry.payload as number) };
            }

            return state;
        });

        source.applyEvent("increment", 5);

        expect(source.state).toEqual({ count: 5 });

        source.applyEvent("increment", 3);

        expect(source.state).toEqual({ count: 8 });
    });

    it("emits state-changed after each event", () => {
        expect.assertions(1);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        const calls: number[] = [];

        source.emitter.on("state-changed", ({ state }) => {
            calls.push((state as { count: number }).count);
        });

        source.applyEvent("inc", null);
        source.applyEvent("inc", null);

        expect(calls).toEqual([1, 2]);
    });

    it("emits ready after replay", () => {
        expect.hasAssertions();

        const source2 = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        const log2 = new EventLog();
        log2.append("inc", null);
        log2.append("inc", null);

        let readyCalled = false;

        source2.emitter.on("ready", ({ entryCount }) => {
            readyCalled = true;

            expect(entryCount).toBe(2);
        });

        source2.replayFromLog(log2);

        expect(readyCalled).toBe(true);
        expect(source2.replayed).toBe(true);
        expect(source2.state).toEqual({ count: 2 });
    });

    it("skips entries that cause reducer errors during replay", () => {
        expect.assertions(3);

        const source = new EventSource({ items: [] as string[] }, (state, entry) => {
            if (entry.type === "bad") {
                throw new Error("bad entry");
            }

            return { items: [...state.items, entry.payload as string] };
        });

        const log = new EventLog();

        log.append("ok", "a");
        log.append("bad", null);
        log.append("ok", "b");

        const errors: { entry: { seq: number }; error: Error }[] = [];

        source.emitter.on("replay-error", ({ entry, error }) => {
            errors.push({ entry, error });
        });

        source.replayFromLog(log);

        expect(source.state).toEqual({ items: ["a", "b"] });
        expect(errors).toHaveLength(1);
        expect(errors[0]!.entry.seq).toBe(1);
    });

    it("yields replayed entries to a live `events()` generator", async () => {
        expect.assertions(2);

        const source = new EventSource({ items: [] as string[] }, (state, entry) => ({ items: [...state.items, entry.payload as string] }));
        const iterator = source.events()[Symbol.asyncIterator]();

        // Park the generator in its "stream future entries" phase first, so the
        // entries below can only reach it through the live notification — the
        // one `replayFromLog` never emitted, which made every replayed entry
        // invisible to a generator the method contract promises to feed.
        source.applyEvent("ok", "a");

        await expect(iterator.next()).resolves.toMatchObject({ value: { payload: "a" } });

        const log = new EventLog();

        log.append("ok", "b");
        log.append("ok", "c");

        source.replayFromLog(log);

        const first = await iterator.next();
        const second = await iterator.next();

        expect([first.value, second.value].map((entry) => entry?.payload)).toStrictEqual(["b", "c"]);

        await iterator.return?.(undefined);
    });

    it("keeps a replayed entry's own timestamp instead of stamping the replay time", () => {
        expect.assertions(1);

        const source = new EventSource({ count: 0 }, (state) => ({ count: state.count + 1 }));
        const log = new EventLog();

        log.append("inc", null, undefined, { timestamp: 111 });
        source.replayFromLog(log);

        expect(source.log.getSince(0).map((entry) => entry.timestamp)).toStrictEqual([111]);
    });

    it("reset restores initial state without clearing log", () => {
        expect.assertions(4);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);
        source.applyEvent("inc", null);

        expect(source.state).toEqual({ count: 2 });

        source.reset({ count: 0 });

        expect(source.state).toEqual({ count: 0 });
        expect(source.replayed).toBe(false);
        expect(source.log.size).toBe(2); // Log is preserved
    });

    it("replayFromLog after reset replays from watermark", () => {
        expect.assertions(1);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);
        source.applyEvent("inc", null);

        source.reset({ count: 100 });

        // The log still has the 2 entries — replay them
        source.replayFromLog(source.log);

        expect(source.state).toEqual({ count: 102 });
    });

    it("reset with a resume watermark replays only post-snapshot source entries", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        // External source log with three events (seq 0, 1, 2).
        const srcLog = new EventLog();

        srcLog.append("inc", null);
        srcLog.append("inc", null);
        srcLog.append("inc", null);

        // Simulate a snapshot that already baked in events up to seq 1
        // (count would be 2); resume past that watermark.
        source.reset({ count: 2 }, 1);

        expect(source.replayed).toBe(true);

        source.replayFromLog(srcLog);

        // Only seq 2 applies on top of the snapshot — no double-counting.
        expect(source.state).toEqual({ count: 3 });
    });

    it("applyEvent forwards AppendOptions to the log entry", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        const entry = source.applyEvent("inc", null, {
            clientId: "client-x",
            sessionId: "session-y",
        });

        expect(entry.clientId).toBe("client-x");
        expect(entry.sessionId).toBe("session-y");
    });

    it("applyEvent with InputEvent accepts AppendOptions", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        const input = { type: "inc" as const, payload: null, timestamp: Date.now() };
        const entry = source.applyEvent(input, { clientId: "client-z" });

        expect(entry.clientId).toBe("client-z");
        expect(entry.type).toBe("inc");
    });

    // REPLICA-06: maxLogEntries bounds `source.log` over a long run.
    it("maxLogEntries caps the internal log over a long run", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state) => ({ count: state.count + 1 }), { maxLogEntries: 5 });

        for (let index = 0; index < 100; index += 1) {
            source.applyEvent("inc", null);
        }

        expect(source.log.size).toBe(5);
        // The derived state itself is unaffected by the log cap.
        expect(source.state).toStrictEqual({ count: 100 });
    });
});

// ─── EventSource — events() async iterator ─────────────────────────────

describe("eventSource.events()", () => {
    it("yields past entries immediately", async () => {
        expect.assertions(1);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);
        source.applyEvent("inc", null);

        const collected: { type: string }[] = [];

        for await (const entry of source.events()) {
            collected.push({ type: entry.type });

            if (collected.length === 2) {
                break;
            }
        }

        expect(collected).toEqual([{ type: "inc" }, { type: "inc" }]);
    });

    it("streams future entries after past ones are exhausted", async () => {
        expect.assertions(3);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : state));

        source.applyEvent("inc", null);

        const collected: { type: string }[] = [];
        const iterator = source.events();

        // Consume the one past entry, then start listening for future
        const first = await iterator.next();

        expect(first.value).toBeDefined();

        collected.push({ type: first.value!.type });

        // Push another event — iterator should pick it up
        source.applyEvent("inc", null);

        const second = await iterator.next();

        expect(second.value).toBeDefined();

        collected.push({ type: second.value!.type });

        expect(collected).toEqual([{ type: "inc" }, { type: "inc" }]);
    });
});

// ─── EventSource — unknownEventHandling ─────────────────────────────────

describe("eventSource unknownEventHandling", () => {
    it("warn logs and skips unknown events (default)", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : UNHANDLED));

        source.applyEvent("inc", null);
        source.applyEvent("unknown", 42);

        expect(source.state).toEqual({ count: 1 });
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("ignore silently skips unknown events", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : UNHANDLED), {
            unknownEventHandling: "ignore",
        });

        source.applyEvent("inc", null);
        source.applyEvent("unknown", 42);

        expect(source.state).toEqual({ count: 1 });
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    it("fail throws on unknown events", () => {
        expect.assertions(2);

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : UNHANDLED), {
            unknownEventHandling: "fail",
        });

        source.applyEvent("inc", null);

        expect(() => source.applyEvent("unknown", 42)).toThrow("unhandled event type");
        expect(source.state).toEqual({ count: 1 });
    });

    it("custom handler is called with the entry", () => {
        expect.assertions(2);

        const handler = vi.fn<(entry: EventLogEntry) => boolean>();

        const source = new EventSource({ count: 0 }, (state, entry) => (entry.type === "inc" ? { count: state.count + 1 } : UNHANDLED), {
            unknownEventHandling: handler,
        });

        source.applyEvent("inc", null);
        source.applyEvent("unknown", 42);

        expect(source.state).toEqual({ count: 1 });
        expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "unknown", payload: 42 }));
    });

    // REPLICA-07: a reducer that recognises a type but legitimately returns
    // `state` unchanged (an idempotent no-op) must NOT be misclassified as
    // "unhandled" via reference equality — only an explicit UNHANDLED return
    // should trigger the unknown-event strategy.
    it("a recognised, idempotent no-op reducer does not warn or invoke the unknown strategy", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        // eslint-disable-next-line sonarjs/function-return-type -- reducer contract is `S | typeof UNHANDLED`; the object/state/symbol arms trip the heuristic
        const source = new EventSource({ count: 0 }, (state, entry) => {
            if (entry.type === "inc") {
                return { count: state.count + 1 };
            }

            if (entry.type === "noop") {
                // Recognised type — the reducer decided nothing changes.
                // Returning `state` by reference must still count as "handled".
                return state;
            }

            return UNHANDLED;
        });

        const stateChanges: unknown[] = [];

        source.emitter.on("state-changed", ({ state }) => stateChanges.push(state));

        source.applyEvent("inc", null);
        source.applyEvent("noop", null);

        expect(source.state).toEqual({ count: 1 });
        expect(warn).not.toHaveBeenCalled();
        // Both events — including the no-op — are recognised as handled and
        // emit state-changed.
        expect(stateChanges).toHaveLength(2);

        warn.mockRestore();
    });
});

// ─── SubscriptionManager ─────────────────────────────────────────────

describe(SubscriptionManager, () => {
    it("onStateChange notifies on notifyState", () => {
        expect.assertions(1);

        const subs = new SubscriptionManager();
        const calls: unknown[] = [];

        subs.onStateChange((s) => calls.push(s));
        subs.notifyState({ x: 1 });

        expect(calls).toEqual([{ x: 1 }]);
    });

    it("onEvent notifies on matching event type", () => {
        expect.assertions(1);

        const subs = new SubscriptionManager();
        const calls: string[] = [];

        subs.onEvent("user-created", (entry) => calls.push(entry.type));

        subs.notifyEvent({
            seq: 0,
            type: "user-created",
            payload: { id: "1" },
            timestamp: 100,
        });

        subs.notifyEvent({
            seq: 1,
            type: "other",
            payload: {},
            timestamp: 200,
        });

        expect(calls).toEqual(["user-created"]);
    });

    it("unsubscribe stops notifications", () => {
        expect.assertions(1);

        const subs = new SubscriptionManager();
        const calls: unknown[] = [];

        const unsub = subs.onStateChange((s) => calls.push(s));
        unsub();
        subs.notifyState({ x: 1 });

        expect(calls).toEqual([]);
    });

    it("handles subscriber exceptions gracefully", () => {
        expect.assertions(1);

        const subs = new SubscriptionManager();
        const calls: number[] = [];

        subs.onStateChange(() => {
            throw new Error("boom");
        });
        subs.onStateChange(() => calls.push(1));
        subs.notifyState({ ok: true });

        expect(calls).toEqual([1]);
    });

    it("clear removes all subscriptions", () => {
        expect.assertions(1);

        const subs = new SubscriptionManager();
        const calls: unknown[] = [];

        subs.onStateChange((s) => calls.push(s));
        subs.clear();
        subs.notifyState({ x: 1 });

        expect(calls).toEqual([]);
    });

    it("size tracks subscription count", () => {
        expect.assertions(5);

        const subs = new SubscriptionManager();

        expect(subs.size).toBe(0);

        const unsub1 = subs.onStateChange(() => {});

        expect(subs.size).toBe(1);

        const unsub2 = subs.onEvent("test", () => {});

        expect(subs.size).toBe(2);

        unsub1();

        expect(subs.size).toBe(1);

        unsub2();

        expect(subs.size).toBe(0);
    });
});

// ─── InMemorySnapshotStore ────────────────────────────────────────────

describe(InMemorySnapshotStore, () => {
    it("save and load round-trip", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();
        const data = { users: [{ id: "1", name: "alice" }] };

        await store.save("test-key", data);
        const loaded = await store.load("test-key");

        expect(loaded).toEqual(data);
    });

    it("load returns null for missing key", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();

        await expect(store.load("missing")).resolves.toBeNull();
    });

    it("list returns stored keys", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();

        await store.save("a", 1);
        await store.save("b", 2);

        const keys = await store.list();

        expect(keys.sort()).toEqual(["a", "b"]);
    });

    it("delete removes a snapshot", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();

        await store.save("x", 1);
        await store.delete("x");

        await expect(store.load("x")).resolves.toBeNull();
    });

    it("clear removes all snapshots", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();

        await store.save("a", 1);
        await store.save("b", 2);
        await store.clear();

        await expect(store.list()).resolves.toEqual([]);
    });

    it("deep-clones stored data", async () => {
        expect.assertions(1);

        const store = new InMemorySnapshotStore();
        const original = { nested: { value: 1 } };

        await store.save("key", original);
        original.nested.value = 99; // Mutate original

        const loaded = await store.load("key");

        expect(loaded).toEqual({ nested: { value: 1 } }); // Stored copy unchanged
    });
});
