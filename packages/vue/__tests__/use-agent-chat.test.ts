import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { AgentLiveEvent, UseAgentChatApi, UseAgentChatResult } from "../src/use-agent-chat";
import { useAgentChat } from "../src/use-agent-chat";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

// A narrow live-token stream reference (`{ key: string }` args, `AgentLiveEvent`
// returns). Typed exactly rather than down-cast from a widened `FunctionReference`.
const makeStreamRef = (reference: string): FunctionReference<"stream", { key: string }, AgentLiveEvent> => {
    return { __lunoraRef: reference };
};

const MESSAGES_REF = "agents:agentMessages";
const THREAD_REF = "agents:agentThread";
const APPROVAL_REF = "agents:agentResolveApproval";
const SEND_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";
const STREAM_REF = "chat:liveEvents";

const buildApi = (): UseAgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as UseAgentChatApi;

describe(useAgentChat, () => {
    // `useAgentChat` is built on `useSubscription`, which gates its
    // subscriptions on a browser `window` (SSR guard); the vitest env is
    // `node` (no `window`), so define one for these client-path tests. The
    // dedicated SSR test below removes it to exercise the guard, mirroring
    // `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        // Both the history and thread channels open on setup.
        expect(fake.subscribeCalls.map((call) => call.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(chat.messages.value).toStrictEqual([]);
        expect(chat.status.value).toBeUndefined();
        // No stream reference supplied — streamingText stays empty (no stream opens).
        expect(chat.streamingText.value).toBe("");
        expect(fake.streamCalls).toHaveLength(0);

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(chat.status.value).toBe("running");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        scope.stop();
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({
                    api: buildApi(),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                }),
            ),
        )!;

        // The live event stream opens alongside the durable subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);
        expect(fake.streamCalls[0]?.args).toStrictEqual({ key: "t1" });

        // Turn-0 deltas (no assistant persisted yet) accumulate into streamingText.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "lo", threadKey: "t1", turn: 0 });
        await fake.flush();

        expect(chat.streamingText.value).toBe("Hello");

        // Progress events ride the same stream but carry no turn text — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(chat.streamingText.value).toBe("Hello");

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "Hello", role: "assistant", seq: 1 },
        ]);

        expect(chat.streamingText.value).toBe("");

        scope.stop();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        await chat.send("hello there");

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: SEND_REF }), { input: "hello there", threadKey: "t1" }, undefined);
        expect(chat.messages.value).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);

        scope.stop();
    });

    it("drops un-acked optimistic rows when threadKey changes, so they never ghost into the new thread", async () => {
        expect.hasAssertions();

        // Regression: a reactive `threadKey` re-subscribed history/thread/stream but
        // left the `optimistic` array alone. `reconcileOptimistic` retires a row by
        // comparing `maxDurableSeqAtSend` against durable `seq`s, and `seq` is PER
        // THREAD — so a row sent in a 40-message thread A, still un-acked when the
        // user switched to an empty thread B, could never be claimed there (B's max
        // seq is -1) and rendered as a ghost `optimistic: true` bubble in B.
        const fake = createFakeClient();
        const threadKey = ref("thread-a");
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult => useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey })),
        )!;

        const threadA = Array.from({ length: 40 }, (_unused, index) => {
            return {
                content: `row-${String(index)}`,
                role: index % 2 === 0 ? "user" : "assistant",
                seq: index,
            };
        });

        fake.push(MESSAGES_REF, { key: "thread-a" }, threadA);

        await chat.send("only meant for A");

        expect(chat.messages.value).toHaveLength(41);

        // Switch threads before the ack lands; thread B's history lands empty.
        threadKey.value = "thread-b";
        await nextTick();
        fake.push(MESSAGES_REF, { key: "thread-b" }, []);

        expect(chat.messages.value).toStrictEqual([]);

        scope.stop();
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        // First send of "hi": acked by the server, durable history now has one "hi".
        await chat.send("hi");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages.value).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await chat.send("hi");

        expect(chat.messages.value).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(chat.messages.value).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        scope.stop();
    });

    it("retires the optimistic row under a saturated windowed limit, where the durable user-row count stays flat", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), limit: 50, send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        // A bounded window (limit 50) saturated by 25 completed turns — a user row
        // and an assistant row each, seqs 0..49, so 25 durable user rows.
        const seededWindow: Record<string, unknown>[] = [];

        for (let turn = 0; turn < 25; turn += 1) {
            seededWindow.push(
                { content: `q-${String(turn)}`, role: "user", seq: turn * 2 },
                { content: `a-${String(turn)}`, role: "assistant", seq: turn * 2 + 1 },
            );
        }

        fake.push(MESSAGES_REF, { key: "t1", limit: 50 }, seededWindow);

        // Send a new turn — its optimistic row renders atop the saturated window.
        await chat.send("new turn");

        expect(chat.messages.value.at(-1)).toStrictEqual({ content: "new turn", optimistic: true, role: "user", seq: 50 });

        // The turn lands (user seq 50 + assistant seq 51) and the window slides to
        // keep its last 50 rows, evicting the oldest turn (seqs 0, 1). The durable
        // USER-row count is unchanged (still 25), so a positional/count reconcile
        // could never see the acknowledging row — the seq-based content match
        // (user "new turn" at seq 50 > the send-time max of 49) retires it instead,
        // window-independent because it matches on the monotonic seq, not a count.
        const slidWindow = [...seededWindow.slice(2), { content: "new turn", role: "user", seq: 50 }, { content: "answer", role: "assistant", seq: 51 }];

        fake.push(MESSAGES_REF, { key: "t1", limit: 50 }, slidWindow);

        const reconciled = chat.messages.value;

        // No ghost: "new turn" appears exactly once, as the durable row, never
        // flagged optimistic — and the merged list is just the 50-row window.
        expect(reconciled.filter((message) => message.content === "new turn")).toStrictEqual([{ content: "new turn", role: "user", seq: 50 }]);
        expect(reconciled).toHaveLength(50);

        scope.stop();
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "awaiting_input" });

        await chat.approve("call-1");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            undefined,
        );

        await chat.reject("call-2", "not allowed");

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: APPROVAL_REF }),
            { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            undefined,
        );

        await chat.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        scope.stop();
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" }),
            ),
        )!;

        await expect(chat.approve("call-1")).rejects.toThrow("no in-flight run");

        scope.stop();
    });

    // A session expiry or RLS denial on the history/thread subscriptions used to be
    // dropped: `messages` / `status` simply froze with nothing to read and no
    // handler to call. Matches React's `useAgentChat` error channel.
    it("surfaces a history subscription error on `error` and through `onError`", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const seen: { code?: string; message: string }[] = [];
        const scope = effectScope();
        const chat = scope.run(() =>
            fake.provide((): UseAgentChatResult =>
                useAgentChat({
                    api: buildApi(),
                    onError: (subscriptionError) => seen.push(subscriptionError),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        fake.subscribeCalls.find((call) => call.functionPath === MESSAGES_REF)?.options.onError?.({ code: "FORBIDDEN", message: "denied" });

        expect(chat.error.value?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);

        scope.stop();
    });
});
