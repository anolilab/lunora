import type { SecretValueHost } from "@lunora/platform";
import { createReferenceHost } from "@lunora/platform/conformance";
import { describe, expect, it } from "vitest";

import { agentComponent } from "../src/component";
import { fakeDatabase } from "./loop-harness";

const SECRET = "sk_live_correct-horse-battery-staple";

interface Caller {
    agents: Record<string, { sendEvent: (id: string, event: { payload: unknown; type: string }) => Promise<void> }>;
    sent: { event: { payload: unknown; type: string }; id: string }[];
}

/** A `ctx.agents` double recording every wake-up the secret mutations send. */
const fakeAgents = (fail?: Error): Caller => {
    const sent: Caller["sent"] = [];

    return {
        agents: {
            support: {
                sendEvent: async (id, event) => {
                    if (fail !== undefined) {
                        throw fail;
                    }

                    sent.push({ event, id });
                },
            },
        },
        sent,
    };
};

/** Store spy: counts what the mutations put and discard, delegating to the real reference store. */
const spyStore = (): { discarded: string[]; puts: string[]; store: SecretValueHost } => {
    const { secretValues } = createReferenceHost();

    if (secretValues === undefined) {
        throw new Error("the reference host must provide a secret store");
    }

    const puts: string[] = [];
    const discarded: string[] = [];

    return {
        discarded,
        puts,
        store: {
            discard: async (ref) => {
                discarded.push(ref);

                return secretValues.discard(ref);
            },
            put: async (value, options) => {
                const ref = await secretValues.put(value, options);

                // Recorded only once the host accepted the value, so a refused put is not a store.
                puts.push(value);

                return ref;
            },
            take: (ref, options) => secretValues.take(ref, options),
        },
    };
};

type Handler = { handler: (context: unknown, args: never) => unknown };
const call = async (fn: unknown, context: unknown, args: Record<string, unknown>): Promise<unknown> => (fn as Handler).handler(context, args as never);

/** A thread owned by `owner` (or ownerless) with a pending `requestSecretTool` marker for `call_1`. */
const stagedThread = async (owner: string | undefined, store?: SecretValueHost, caller: Caller = fakeAgents()) => {
    const { functions } = agentComponent();
    const { database, rows } = fakeDatabase();
    const ctx = { agentSecrets: store, agents: caller.agents, auth: { userId: owner }, db: database };

    await call(functions.agentEnsureThread, ctx, { agent: "support", instanceId: "wf-1", key: "t-1", ...(owner === undefined ? {} : { owner }) });
    await call(functions.agentAppendMessage, ctx, {
        content: 'Awaiting a secret for tool "requestKey".',
        messageKey: "wf-1:secret:call_1",
        role: "tool",
        status: "awaiting_secret",
        threadKey: "t-1",
        toolCallId: "call_1",
        toolName: "requestKey",
    });

    return { caller, ctx, functions, rows };
};

const markerCount = (rows: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>): number =>
    (rows.get("agent_messages") ?? []).filter((row) => row["status"] === "awaiting_secret").length;

describe("agentSupplySecret", () => {
    it("stores the value, wakes the run with only the ref, and returns no value", async () => {
        expect.assertions(6);

        const { store, puts } = spyStore();
        const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

        const result = await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

        expect(result).toStrictEqual({ resolved: true });
        expect(puts).toStrictEqual([SECRET]);
        expect(caller.sent).toHaveLength(1);
        expect(caller.sent[0]?.event.type).toBe("agent-secret:call_1");
        expect(JSON.stringify(caller.sent)).not.toContain(SECRET);
        expect(markerCount(rows)).toBe(0);
    });

    it("fails closed for an anonymous caller, storing nothing", async () => {
        expect.assertions(3);

        const { store, puts } = spyStore();
        const { caller, ctx, functions } = await stagedThread("user-a", store);

        await expect(call(functions.agentSupplySecret, { ...ctx, auth: {} }, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject(
            {
                code: "FORBIDDEN",
            },
        );
        expect(puts).toStrictEqual([]);
        expect(caller.sent).toStrictEqual([]);
    });

    it("refuses an ownerless thread even to an authenticated caller, since anyone with the key could read it", async () => {
        expect.assertions(2);

        const { store, puts } = spyStore();
        const { ctx, functions } = await stagedThread(undefined, store);

        await expect(
            call(functions.agentSupplySecret, { ...ctx, auth: { userId: "user-a" } }, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" }),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(puts).toStrictEqual([]);
    });

    it("refuses a caller who owns a different thread", async () => {
        expect.assertions(2);

        const { store, puts } = spyStore();
        const { ctx, functions } = await stagedThread("user-a", store);

        await expect(
            call(functions.agentSupplySecret, { ...ctx, auth: { userId: "user-b" } }, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" }),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(puts).toStrictEqual([]);
    });

    it("refuses with a typed error on a target without a secret store, before accepting the value", async () => {
        expect.assertions(2);

        const { caller, ctx, functions } = await stagedThread("user-a");

        await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
            code: "NOT_IMPLEMENTED",
        });
        expect(caller.sent).toStrictEqual([]);
    });

    it("answers a second submit with CONFLICT rather than a second stored value", async () => {
        expect.assertions(3);

        const { store, puts } = spyStore();
        const { ctx, functions } = await stagedThread("user-a", store);

        await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

        await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(puts).toHaveLength(1);
        expect(puts).toStrictEqual([SECRET]);
    });

    it("answers a late supply, after the loop retired the marker on timeout, with CONFLICT and stores nothing", async () => {
        expect.assertions(3);

        const { store, puts } = spyStore();
        const { ctx, functions, rows } = await stagedThread("user-a", store);

        // The loop's timeout branch retires the marker (`agentDeleteMessage`).
        await call(functions.agentDeleteMessage, ctx, { messageKey: "wf-1:secret:call_1", threadKey: "t-1" });

        await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(puts).toStrictEqual([]);
        expect(markerCount(rows)).toBe(0);
    });

    it("discards the stored value when the wake-up never lands, then rethrows", async () => {
        expect.assertions(3);

        const { store, discarded } = spyStore();
        const { ctx, functions } = await stagedThread("user-a", store, fakeAgents(new Error("dispatch down")));

        await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toThrow("dispatch down");
        expect(discarded).toHaveLength(1);

        const [ref] = discarded;

        await expect(store.take(ref as string, { claimant: "tool:x:1", scope: "t-1" })).resolves.toBeUndefined();
    });

    it("rejects an over-size value with PAYLOAD_TOO_LARGE and keeps the marker pending", async () => {
        expect.assertions(4);

        const { store, puts } = spyStore();
        const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

        await expect(call(functions.agentSupplySecret, ctx, { secret: "x".repeat(9000), threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
            code: "PAYLOAD_TOO_LARGE",
        });
        expect(caller.sent).toStrictEqual([]);
        expect(markerCount(rows)).toBe(1);

        expect(puts).toHaveLength(0);
    });
});

describe("the plaintext argument", () => {
    it("is named `secret`, the name the request log masks", () => {
        expect.assertions(1);

        const { args } = agentComponent().functions.agentSupplySecret as unknown as { args: Record<string, unknown> };

        expect(Object.keys(args)).toContain("secret");
    });
});

describe("agentDeclineSecret", () => {
    it("retires the marker and wakes the run with a decline, storing nothing", async () => {
        expect.assertions(4);

        const { store, puts } = spyStore();
        const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

        await expect(call(functions.agentDeclineSecret, ctx, { threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({ resolved: true });
        expect(caller.sent).toStrictEqual([{ event: { payload: { declined: true }, type: "agent-secret:call_1" }, id: "wf-1" }]);
        expect(markerCount(rows)).toBe(0);
        expect(puts).toStrictEqual([]);
    });

    it("applies the same owner gate as supply", async () => {
        expect.assertions(1);

        const { ctx, functions } = await stagedThread("user-a", spyStore().store);

        await expect(
            call(functions.agentDeclineSecret, { ...ctx, auth: { userId: "user-b" } }, { threadKey: "t-1", toolCallId: "call_1" }),
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });
});

describe("agentTakeSecret and agentDiscardSecret", () => {
    it("binds the first claimant, lets it re-take, refuses others, and discards", async () => {
        expect.assertions(5);

        const { store } = spyStore();
        const { caller, ctx, functions } = await stagedThread("user-a", store);

        await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

        // The ref the run was woken with is the only handle the loop ever holds.
        const { ref } = caller.sent[0]?.event.payload as { ref: string };
        const take = (claimant: string, threadKey = "t-1"): Promise<unknown> => call(functions.agentTakeSecret, ctx, { claimant, ref, threadKey });

        await expect(take("tool:charge:call_2")).resolves.toBe(SECRET);

        await expect(take("tool:charge:call_2")).resolves.toBe(SECRET);

        await expect(take("tool:other:call_3")).resolves.toBeUndefined();

        await expect(take("tool:charge:call_2", "t-other")).resolves.toBeUndefined();

        await call(functions.agentDiscardSecret, ctx, { ref });

        await expect(take("tool:charge:call_2")).resolves.toBeUndefined();
    });

    it("exposes the take and discard mutations internally only", () => {
        expect.assertions(2);

        const { functions } = agentComponent();

        expect((functions.agentTakeSecret as { visibility?: string }).visibility).toBe("internal");
        expect((functions.agentDiscardSecret as { visibility?: string }).visibility).toBe("internal");
    });
});
