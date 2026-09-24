import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { AgentLiveEvent } from "../src/agent";
import type { AgentChatApi, AgentChatResult } from "../src/agent-chat";
import { agentChat } from "../src/agent-chat";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

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

const buildApi = (): AgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentChatApi;

describe(agentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        // Both the history and thread channels open on setup.
        expect(fake.subscriptions.map((sub) => sub.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(chat.messages()).toStrictEqual([]);
        expect(chat.status()).toBeUndefined();
        // No stream reference supplied — streamingText stays empty (no stream opens).
        expect(chat.streamingText()).toBe("");
        expect(fake.streamCalls).toHaveLength(0);

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(chat.status()).toBe("running");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        destroy.destroy();
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            stream: makeStreamRef(STREAM_REF),
            threadKey: "t1",
        });

        // The live event stream opens alongside the durable subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);
        expect(fake.streamCalls[0]?.args).toStrictEqual({ key: "t1" });

        // Turn-0 deltas (no assistant persisted yet) accumulate into streamingText.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "lo", threadKey: "t1", turn: 0 });
        await fake.flush();

        expect(chat.streamingText()).toBe("Hello");

        // Progress events ride the same stream but carry no turn text — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(chat.streamingText()).toBe("Hello");

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "Hello", role: "assistant", seq: 1 },
        ]);

        expect(chat.streamingText()).toBe("");

        destroy.destroy();
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        await chat.send("hello there");

        expect(fake.mutationCalls).toContainEqual({ args: { input: "hello there", threadKey: "t1" }, functionPath: SEND_REF, options: undefined });
        expect(chat.messages()).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(chat.messages()).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);

        destroy.destroy();
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        // First send of "hi": acked by the server, durable history now has one "hi".
        await chat.send("hi");

        fake.push(MESSAGES_REF, { key: "t1" }, [{ content: "hi", role: "user", seq: 0 }]);

        expect(chat.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await chat.send("hi");

        expect(chat.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        fake.push(MESSAGES_REF, { key: "t1" }, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(chat.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        destroy.destroy();
    });

    it("retires the optimistic row under a saturated windowed limit, where the durable user-row count stays flat", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            limit: 50,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

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

        expect(chat.messages().at(-1)).toStrictEqual({ content: "new turn", optimistic: true, role: "user", seq: 50 });

        // The turn lands (user seq 50 + assistant seq 51) and the window slides to
        // keep its last 50 rows, evicting the oldest turn (seqs 0, 1). The durable
        // USER-row count is unchanged (still 25), so a positional/count reconcile
        // could never see the acknowledging row — the seq-based content match
        // (user "new turn" at seq 50 > the send-time max of 49) retires it instead,
        // window-independent because it matches on the monotonic seq, not a count.
        const slidWindow = [...seededWindow.slice(2), { content: "new turn", role: "user", seq: 50 }, { content: "answer", role: "assistant", seq: 51 }];

        fake.push(MESSAGES_REF, { key: "t1", limit: 50 }, slidWindow);

        const reconciled = chat.messages();

        // No ghost: "new turn" appears exactly once, as the durable row, never
        // flagged optimistic — and the merged list is just the 50-row window.
        expect(reconciled.filter((message) => message.content === "new turn")).toStrictEqual([{ content: "new turn", role: "user", seq: 50 }]);
        expect(reconciled).toHaveLength(50);

        destroy.destroy();
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "awaiting_input" });

        await chat.approve("call-1");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            functionPath: APPROVAL_REF,
            options: undefined,
        });

        await chat.reject("call-2", "not allowed");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            functionPath: APPROVAL_REF,
            options: undefined,
        });

        await chat.cancel();

        expect(fake.mutationCalls).toContainEqual({ args: { instanceId: "wf-1", threadKey: "t1" }, functionPath: CANCEL_REF, options: undefined });

        destroy.destroy();
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        await expect(chat.approve("call-1")).rejects.toThrow("no in-flight run");

        destroy.destroy();
    });

    // A session expiry or RLS denial on the thread/history subscription used to be
    // dropped: `status` simply froze with nothing to read and no handler to call.
    // Matches React's `useAgent` / `useAgentChat` error channel.
    it("surfaces a history subscription error on `error` and through `onError`", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const seen: { code?: string; message: string }[] = [];

        const chat: AgentChatResult = agentChat({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            onError: (subscriptionError) => seen.push(subscriptionError),
            send: makeRef(SEND_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.subscriptions.find((sub) => sub.functionPath === MESSAGES_REF)?.emitError({ code: "FORBIDDEN", message: "denied" });

        expect(chat.error()?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);

        destroy.destroy();
    });
});
