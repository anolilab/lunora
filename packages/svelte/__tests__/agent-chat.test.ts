import type { FunctionReference, SubscriptionError } from "@lunora/client";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentChatApi, AgentLiveEvent } from "../src/agent-chat";
import { agentChat } from "../src/agent-chat";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// The token stream must be referenced exactly — a widened `FunctionReference<"stream">`
// is not assignable to the phantom-typed `AgentTokenStreamReference`.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";
const STREAM_REF = "chat:agentEvents";

const buildApi = (): AgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentChatApi;

describe(agentChat, () => {
    beforeEach(() => {
        // `agentChat` gates its history/thread subscriptions on a browser
        // `window` (SVELTE-01); the vitest env is `node` (no `window`), so
        // define one for these client-path tests. The SSR test below removes
        // it to exercise the guard, mirroring `presence.test.ts`.
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // Both the history and thread channels open eagerly on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(get(handle.messages)).toStrictEqual([]);
        expect(get(handle.status)).toBeUndefined();
        // With no `stream` reference the token stream is opened with `"skip"` args,
        // so no stream is opened and `streamingText` stays empty.
        expect(fake.streamCalls).toHaveLength(0);
        expect(get(handle.streamingText)).toBe("");

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(get(handle.status)).toBe("running");

        fake.push(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        handle.teardown();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
    });

    it("forwards onError so a history or thread subscription error reaches the caller", () => {
        // Without an error channel a session expiry left `messages` / `status`
        // frozen at their last value with nothing surfaced.
        const fake = createFakeClient();
        const errors: SubscriptionError[] = [];

        agentChat(fake.client, {
            api: buildApi(),
            onError: (error) => errors.push(error),
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        for (const call of fake.subscribeCalls) {
            call.options.onError?.({ code: "UNAUTHORIZED", message: `expired:${call.functionPath}` });
        }

        expect(errors.map((error) => error.message).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([`expired:${MESSAGES_REF}`, `expired:${THREAD_REF}`]);
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, {
            api: buildApi(),
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            stream: makeStreamRef(STREAM_REF),
            threadKey: "t1",
        });

        // The token stream opens eagerly alongside the history/thread subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);

        fake.pushStream(STREAM_REF, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { text: "lo", threadKey: "t1", turn: 0 });
        // A progress event rides the same stream but carries no turn text — ignored here.
        fake.pushStream(STREAM_REF, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(get(handle.streamingText)).toBe("Hello");

        // The turn persists → its assistant row advances the retire gate and the
        // deltas fall away, leaving the persisted message the source of truth.
        fake.push(MESSAGES_REF, [{ content: "Hello", role: "assistant", seq: 0 }]);

        expect(get(handle.streamingText)).toBe("");

        handle.teardown();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        await handle.send("hello there");

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: SEND_REF }), { input: "hello there", threadKey: "t1" }, undefined);
        expect(get(handle.messages)).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        fake.push(MESSAGES_REF, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);

        handle.teardown();
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // First send of "hi": acked by the server, durable history now has one "hi".
        await handle.send("hi");

        fake.push(MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(get(handle.messages)).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await handle.send("hi");

        expect(get(handle.messages)).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        fake.push(MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(get(handle.messages)).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        handle.teardown();
    });

    it("retires the optimistic row under a saturated windowed limit, where the durable user-row count stays flat", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), limit: 50, send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        // A bounded window (limit 50) saturated by 25 completed turns — a user row
        // and an assistant row each, seqs 0..49, so 25 durable user rows.
        const seededWindow: Record<string, unknown>[] = [];

        for (let turn = 0; turn < 25; turn += 1) {
            seededWindow.push(
                { content: `q-${String(turn)}`, role: "user", seq: turn * 2 },
                { content: `a-${String(turn)}`, role: "assistant", seq: turn * 2 + 1 },
            );
        }

        fake.push(MESSAGES_REF, seededWindow);

        // Send a new turn — its optimistic row renders atop the saturated window.
        await handle.send("new turn");

        expect(get(handle.messages).at(-1)).toStrictEqual({ content: "new turn", optimistic: true, role: "user", seq: 50 });

        // The turn lands (user seq 50 + assistant seq 51) and the window slides to
        // keep its last 50 rows, evicting the oldest turn (seqs 0, 1). The durable
        // USER-row count is unchanged (still 25), so a positional/count reconcile
        // could never see the acknowledging row — the seq-based content match
        // (user "new turn" at seq 50 > the send-time max of 49) retires it instead,
        // window-independent because it matches on the monotonic seq, not a count.
        const slidWindow = [...seededWindow.slice(2), { content: "new turn", role: "user", seq: 50 }, { content: "answer", role: "assistant", seq: 51 }];

        fake.push(MESSAGES_REF, slidWindow);

        const reconciled = get(handle.messages);

        // No ghost: "new turn" appears exactly once, as the durable row, never
        // flagged optimistic — and the merged list is just the 50-row window.
        expect(reconciled.filter((message) => message.content === "new turn")).toStrictEqual([{ content: "new turn", role: "user", seq: 50 }]);
        expect(reconciled).toHaveLength(50);

        handle.teardown();
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "awaiting_input" });

        await handle.approve("call-1");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            undefined,
        );

        await handle.reject("call-2", "not allowed");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            undefined,
        );

        await handle.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        handle.teardown();
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        const fake = createFakeClient();
        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        await expect(handle.approve("call-1")).rejects.toThrow("no in-flight run");

        handle.teardown();
    });

    it("does not open the history/thread subscriptions during SSR (no window) (SVELTE-01)", () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window` (this package pairs
        // with `@lunora/nuxt`'s server rendering, where a component's init runs
        // inside `renderToString` with no `window`). Opening a live WS
        // subscription there fires during `renderToString` with no
        // corresponding `onDestroy` to close it — every server render would
        // leak a subscription.
        Reflect.deleteProperty(globalThis, "window");

        const handle = agentChat(fake.client, { api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(get(handle.messages)).toStrictEqual([]);
        expect(get(handle.status)).toBeUndefined();

        // Teardown itself must not throw with nothing live to unsubscribe.
        expect(() => {
            handle.teardown();
        }).not.toThrow();
        expect(fake.unsubscribeSpy).not.toHaveBeenCalled();
    });

    it("does not open the eager token stream during SSR (no window) (SVELTE-01)", () => {
        const fake = createFakeClient();

        // Same server-render scenario as above, but with a `stream` reference
        // configured — the eager `stream(...).chunks.subscribe(...)` call must
        // be gated on `isBrowser` too, or it opens (and leaks) a live stream
        // during `renderToString` just like an ungated history/thread
        // subscription would.
        Reflect.deleteProperty(globalThis, "window");

        const handle = agentChat(fake.client, {
            api: buildApi(),
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            stream: makeStreamRef(STREAM_REF),
            threadKey: "t1",
        });

        expect(fake.streamCalls).toHaveLength(0);
        expect(get(handle.streamingText)).toBe("");

        expect(() => {
            handle.teardown();
        }).not.toThrow();
    });
});
