import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import type { AgentLiveEvent, CreateAgentChatApi, CreateAgentChatResult } from "../src/create-agent-chat";
import { createAgentChat } from "../src/create-agent-chat";
import { LunoraProvider } from "../src/lunora-provider";
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

const buildApi = (): CreateAgentChatApi =>
    ({
        agents: {
            agentMessages: makeRef(MESSAGES_REF),
            agentResolveApproval: makeRef(APPROVAL_REF),
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as CreateAgentChatApi;

const pushTo = (subscriptions: { functionPath: string; push: (value: unknown) => void }[], reference: string, value: unknown): void => {
    subscriptions.find((sub) => sub.functionPath === reference)?.push(value);
};

describe(createAgentChat, () => {
    it("surfaces durable history and live status over the agents:* subscriptions", () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // Both the history and thread channels open on setup.
        expect(fake.subscriptions.map((sub) => sub.functionPath).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([MESSAGES_REF, THREAD_REF]);
        expect(latest?.messages()).toStrictEqual([]);
        expect(latest?.status()).toBeUndefined();
        // No stream reference supplied — streamingText stays empty (no stream opens).
        expect(latest?.streamingText()).toBe("");
        expect(fake.streamCalls).toHaveLength(0);

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(latest?.status()).toBe("running");

        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);
    });

    it("accumulates in-flight token deltas into streamingText, then clears once the turn persists", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({
                    api: buildApi(),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    stream: makeStreamRef(STREAM_REF),
                    threadKey: "t1",
                });

                return <pre>{latest.streamingText()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The live event stream opens alongside the durable subscriptions.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([STREAM_REF]);
        expect(fake.streamCalls[0]?.args).toStrictEqual({ key: "t1" });

        // Turn-0 deltas (no assistant persisted yet) accumulate into streamingText.
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "Hel", threadKey: "t1", turn: 0 });
        fake.pushStream(STREAM_REF, { key: "t1" }, { text: "lo", threadKey: "t1", turn: 0 });
        await fake.flush();

        expect(latest?.streamingText()).toBe("Hello");

        // Progress events ride the same stream but carry no turn text — ignored here.
        fake.pushStream(STREAM_REF, { key: "t1" }, { data: { pct: 50 }, kind: "progress", threadKey: "t1", toolCallId: "c1" });
        await fake.flush();

        expect(latest?.streamingText()).toBe("Hello");

        // Once the turn's assistant message persists, its deltas are superseded —
        // streamingText clears (the persisted message is the source of truth).
        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "Hello", role: "assistant", seq: 1 },
        ]);

        expect(latest?.streamingText()).toBe("");
    });

    it("appends an optimistic user turn on send, then reconciles it against durable history", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await latest?.send("hello there");

        expect(fake.mutationCalls).toContainEqual({ args: { input: "hello there", threadKey: "t1" }, functionPath: SEND_REF });
        expect(latest?.messages()).toStrictEqual([{ content: "hello there", optimistic: true, role: "user", seq: 0 }]);

        // The durable turn lands → the optimistic row is reconciled away.
        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hello there", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hello there", role: "user", seq: 0 }]);
    });

    it("drops un-acked optimistic rows when threadKey changes, so they never ghost into the new thread", async () => {
        // Regression: an accessor `threadKey` re-subscribed history/thread/stream but
        // left the `optimistic` signal alone. `reconcileOptimistic` retires a row by
        // comparing `maxDurableSeqAtSend` against durable `seq`s, and `seq` is PER
        // THREAD — so a row sent in a 40-message thread A, still un-acked when the
        // user switched to an empty thread B, could never be claimed there (B's max
        // seq is -1) and rendered as a ghost `optimistic: true` bubble in B.
        const fake = createFakeClient();
        const [threadKey, setThreadKey] = createSignal("thread-a");
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        const threadA = Array.from({ length: 40 }, (_unused, index) => {
            return {
                content: `row-${String(index)}`,
                role: index % 2 === 0 ? "user" : "assistant",
                seq: index,
            };
        });

        pushTo(fake.subscriptions, MESSAGES_REF, threadA);

        await latest?.send("only meant for A");

        expect(latest?.messages()).toHaveLength(41);

        // Switch threads before the ack lands; thread B's history lands empty.
        setThreadKey("thread-b");
        fake.subscriptions.findLast((sub) => sub.functionPath === MESSAGES_REF)?.push([]);

        expect(latest?.messages()).toStrictEqual([]);
    });

    it("shows a fresh optimistic echo for a repeated identical prompt, not reconciled by the earlier durable row", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // First send of "hi": acked by the server, durable history now has one "hi".
        await latest?.send("hi");

        pushTo(fake.subscriptions, MESSAGES_REF, [{ content: "hi", role: "user", seq: 0 }]);

        expect(latest?.messages()).toStrictEqual([{ content: "hi", role: "user", seq: 0 }]);

        // Sending "hi" again must NOT be immediately swallowed by the stale durable
        // "hi" that predates this send — the optimistic echo should render until
        // ITS OWN durable row arrives.
        await latest?.send("hi");

        expect(latest?.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", optimistic: true, role: "user", seq: 1 },
        ]);

        // Once the second durable "hi" lands, the optimistic row reconciles away.
        pushTo(fake.subscriptions, MESSAGES_REF, [
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);

        expect(latest?.messages()).toStrictEqual([
            { content: "hi", role: "user", seq: 0 },
            { content: "hi", role: "user", seq: 1 },
        ]);
    });

    it("retires the optimistic row under a saturated windowed limit, where the durable user-row count stays flat", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        // A bounded window (limit 50) saturated by 25 completed turns — a user row
        // and an assistant row each, seqs 0..49, so 25 durable user rows.
        const seededWindow: Record<string, unknown>[] = [];

        for (let turn = 0; turn < 25; turn += 1) {
            seededWindow.push(
                { content: `q-${String(turn)}`, role: "user", seq: turn * 2 },
                { content: `a-${String(turn)}`, role: "assistant", seq: turn * 2 + 1 },
            );
        }

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), limit: 50, send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{JSON.stringify(latest.messages())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, MESSAGES_REF, seededWindow);

        // Send a new turn — its optimistic row renders atop the saturated window.
        await latest?.send("new turn");

        expect(latest?.messages().at(-1)).toStrictEqual({ content: "new turn", optimistic: true, role: "user", seq: 50 });

        // The turn lands (user seq 50 + assistant seq 51) and the window slides to
        // keep its last 50 rows, evicting the oldest turn (seqs 0, 1). The durable
        // USER-row count is unchanged (still 25), so a positional/count reconcile
        // could never see the acknowledging row — the seq-based content match
        // (user "new turn" at seq 50 > the send-time max of 49) retires it instead,
        // window-independent because it matches on the monotonic seq, not a count.
        const slidWindow = [...seededWindow.slice(2), { content: "new turn", role: "user", seq: 50 }, { content: "answer", role: "assistant", seq: 51 }];

        pushTo(fake.subscriptions, MESSAGES_REF, slidWindow);

        const reconciled = latest?.messages() ?? [];

        // No ghost: "new turn" appears exactly once, as the durable row, never
        // flagged optimistic — and the merged list is just the 50-row window.
        expect(reconciled.filter((message) => message.content === "new turn")).toStrictEqual([{ content: "new turn", role: "user", seq: 50 }]);
        expect(reconciled).toHaveLength(50);
    });

    it("routes approve / reject / cancel with the in-flight instanceId", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "awaiting_input" });

        await latest?.approve("call-1");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "approve", instanceId: "wf-1", threadKey: "t1", toolCallId: "call-1" },
            functionPath: APPROVAL_REF,
        });

        await latest?.reject("call-2", "not allowed");

        expect(fake.mutationCalls).toContainEqual({
            args: { decision: "reject", instanceId: "wf-1", note: "not allowed", threadKey: "t1", toolCallId: "call-2" },
            functionPath: APPROVAL_REF,
        });

        await latest?.cancel();

        expect(fake.mutationCalls).toContainEqual({ args: { instanceId: "wf-1", threadKey: "t1" }, functionPath: CANCEL_REF });
    });

    it("approve rejects when there is no in-flight run to resolve", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({ api: buildApi(), send: makeRef(SEND_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await expect(latest?.approve("call-1")).rejects.toThrow("no in-flight run");
    });

    // A session expiry or RLS denial on the history/thread subscriptions used to be
    // dropped: `messages` / `status` simply froze with nothing to read and no
    // handler to call. Matches React's `useAgentChat` error channel.
    it("surfaces a history subscription error on `error` and through `onError`", () => {
        const fake = createFakeClient();
        const seen: { code?: string; message: string }[] = [];
        let latest: CreateAgentChatResult | undefined;

        render(
            () => {
                latest = createAgentChat({
                    api: buildApi(),
                    onError: (subscriptionError) => seen.push(subscriptionError),
                    send: makeRef(SEND_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions.find((sub) => sub.functionPath === MESSAGES_REF)?.error({ code: "FORBIDDEN", message: "denied" });

        expect(latest?.error()?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
    });
});
