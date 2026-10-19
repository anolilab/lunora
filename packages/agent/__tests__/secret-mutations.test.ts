import type { SecretValueHost } from "@lunora/platform";
import { createReferenceHost } from "@lunora/platform/conformance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentComponent } from "../src/component";
import { fakeDatabase } from "./loop-harness";

const SECRET = "sk_live_correct-horse-battery-staple";
const REQUEST_SECRET_TOOL_PATTERN = /requestSecretTool/u;
const DEADLINE_MS = 60_000;
const NOW = 1_000_000;
const REQUESTS = "agent_secret_requests";

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

/**
 * Store spy: counts what the mutations put and discard, delegating to the real
 * reference store. `afterPut` runs once the host has accepted a value, which is
 * where a test injects the deadline passing or a concurrent settle.
 */
const spyStore = (
    afterPut?: () => void,
    reference: ReturnType<typeof createReferenceHost> = createReferenceHost(),
): { advanceClock: (ms: number) => void; discarded: string[]; puts: string[]; store: SecretValueHost } => {
    const { secretValues, advanceClock } = reference;

    if (secretValues === undefined || advanceClock === undefined) {
        throw new Error("the reference host must provide a secret store and a clock");
    }

    const puts: string[] = [];
    const discarded: string[] = [];

    return {
        advanceClock,
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
                afterPut?.();

                return ref;
            },
            take: (ref, options) => secretValues.take(ref, options),
        },
    };
};

type Handler = { handler: (context: unknown, args: never) => unknown };
const call = async (fn: unknown, context: unknown, args: Record<string, unknown>): Promise<unknown> => (fn as Handler).handler(context, args as never);

/**
 * A thread owned by `owner` (or ownerless), paused on a `requestSecretTool` call
 * `call_1` whose consumer is `charge`. The request row and the marker are written
 * the way the loop writes them.
 */
const stagedThread = async (
    owner: string | undefined,
    store?: SecretValueHost,
    caller: Caller = fakeAgents(),
    label?: string,
    deadlineMs: number = DEADLINE_MS,
) => {
    const { functions } = agentComponent();
    const { database, rows } = fakeDatabase();
    const ctx = { agentSecrets: store, agents: caller.agents, auth: { userId: owner }, db: database };

    await call(functions.agentEnsureThread, ctx, { agent: "support", instanceId: "wf-1", key: "t-1", ...(owner === undefined ? {} : { owner }) });
    await call(functions.agentOpenSecretRequest, ctx, {
        consumerTool: "charge",
        expiresAt: Date.now() + deadlineMs,
        instanceId: "wf-1",
        ...(label === undefined ? {} : { label }),
        threadKey: "t-1",
        toolCallId: "call_1",
        toolName: "requestKey",
    });
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

const requestRow = (rows: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>): Record<string, unknown> => {
    const [row] = rows.get(REQUESTS) ?? [];

    if (row === undefined) {
        throw new Error("no secret request row");
    }

    return row;
};

const take = (functions: ReturnType<typeof agentComponent>["functions"], ctx: unknown, args: Record<string, unknown>): Promise<unknown> =>
    call(functions.agentTakeSecret, ctx, args);

/**
 * Runs a mutation the way the host does: its database writes are one transaction, so a
 * throw restores every row the mutation touched. The secret store sits outside that
 * transaction and is not restored, which is exactly the split the supply path has to handle.
 */
const inTransaction = async (rows: ReturnType<typeof fakeDatabase>["rows"], run: () => Promise<unknown>): Promise<unknown> => {
    const before = structuredClone(rows);

    try {
        return await run();
    } catch (error: unknown) {
        rows.clear();

        for (const [table, content] of before) {
            rows.set(table, content);
        }

        throw error;
    }
};

/** Agents whose wake-up is delivered and then fails to acknowledge, as a dropped response would. */
const ackLostAgents = (): Caller => {
    const sent: Caller["sent"] = [];

    return {
        agents: {
            support: {
                sendEvent: async (id, event) => {
                    sent.push({ event, id });

                    throw new Error("ack lost after delivery");
                },
            },
        },
        sent,
    };
};

/** A promise the test settles on demand, so an interleaving is held at a known point. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        settle = resolve;
    });

    return {
        promise,
        resolve: () => {
            settle();
        },
    };
};

/** Long enough that the 15-minute store TTL is not the bound on the value's lifetime. */
const LONG_DEADLINE_MS = 60 * 60 * 1000;

describe("secret request component", () => {
    beforeEach(() => {
        // Only Date is faked: the expiry rules read the clock, and nothing else here waits on a timer.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("agentSupplySecret", () => {
        it("ignores a pending request a replaced run left under the same call id, and answers the current one", async () => {
            const { store, puts } = spyStore();
            const { ctx, functions } = await stagedThread("user-a", store);

            // A row from a run the thread no longer belongs to, still pending under the same call id.
            await call(functions.agentOpenSecretRequest, ctx, {
                callId: "call_1",
                consumerTool: "charge",
                expiresAt: Date.now() + 60_000,
                instanceId: "wf-old",
                threadKey: "t-1",
                toolCallId: "2:call_1",
                toolName: "requestKey",
            });

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                resolved: true,
            });
            expect(puts).toStrictEqual([SECRET]);
        });

        it("refuses a supply that names two pending requests, rather than guessing which one it answers", async () => {
            const { store, puts } = spyStore();
            const { ctx, functions } = await stagedThread("user-a", store);

            // A second pending request under the same call id, from a later turn.
            await call(functions.agentOpenSecretRequest, ctx, {
                callId: "call_1",
                consumerTool: "charge",
                expiresAt: Date.now() + 60_000,
                instanceId: "wf-1",
                threadKey: "t-1",
                toolCallId: "2:call_1",
                toolName: "requestKey",
            });

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            expect(puts).toStrictEqual([]);
        });

        it("stores the value, marks the request supplied, and wakes the run with an empty payload", async () => {
            expect.assertions(6);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            const result = await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });
            const { ref } = requestRow(rows);

            expect(result).toStrictEqual({ resolved: true });
            expect(puts).toStrictEqual([SECRET]);
            expect(caller.sent).toStrictEqual([{ event: { payload: {}, type: "agent-secret:call_1" }, id: "wf-1" }]);
            expect(requestRow(rows)["status"]).toBe("supplied");
            expect(typeof ref === "string" && JSON.stringify(caller.sent).includes(ref)).toBe(false);
            expect(JSON.stringify([...rows.values()])).not.toContain(SECRET);
        });

        it("fails closed for an anonymous caller, storing nothing", async () => {
            expect.assertions(3);

            const { store, puts } = spyStore();
            const { caller, ctx, functions } = await stagedThread("user-a", store);

            await expect(
                call(functions.agentSupplySecret, { ...ctx, auth: {} }, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" }),
            ).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
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

        it("refuses a supply at or after the deadline, even though the loop has not settled the request", async () => {
            expect.assertions(4);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            vi.setSystemTime(NOW + DEADLINE_MS);

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            expect(puts).toStrictEqual([]);
            expect(caller.sent).toStrictEqual([]);
            expect(requestRow(rows)["status"]).toBe("pending");
        });

        it("refuses a supply whose deadline passes while the host stores it, and discards the stored value", async () => {
            expect.assertions(4);

            const { store, discarded } = spyStore(() => {
                vi.setSystemTime(NOW + DEADLINE_MS);
            });
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            expect(discarded).toHaveLength(1);
            expect(caller.sent).toStrictEqual([]);
            expect(requestRow(rows)["status"]).toBe("pending");
        });

        it("discards the value when the request row cannot move after the put, so a failed supply leaves nothing readable", async () => {
            expect.assertions(5);

            let patchFails = false;
            const { store, discarded } = spyStore(() => {
                patchFails = true;
            });
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);
            const realPatch = (ctx.db as unknown as { patch: (id: string, patch: Record<string, unknown>) => Promise<void> }).patch;
            const flakyCtx = {
                ...ctx,
                db: {
                    ...ctx.db,
                    patch: async (id: string, patch: Record<string, unknown>) => {
                        if (patchFails) {
                            throw new Error("injected: row write failed");
                        }

                        return realPatch(id, patch);
                    },
                },
            };

            await expect(call(functions.agentSupplySecret, flakyCtx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toThrow(
                "injected: row write failed",
            );

            expect(discarded).toHaveLength(1);
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBeUndefined();
            expect(caller.sent).toStrictEqual([]);
            expect(requestRow(rows)["status"]).toBe("pending");
        });

        it("keeps the committed supply when the wake-up was delivered but its acknowledgement failed", async () => {
            expect.assertions(4);

            const { store, discarded } = spyStore();
            const caller = ackLostAgents();
            const { ctx, functions, rows } = await stagedThread("user-a", store, caller);

            await expect(
                inTransaction(rows, () => call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })),
            ).resolves.toStrictEqual({ resolved: true });
            expect(caller.sent).toHaveLength(1);
            expect(discarded).toStrictEqual([]);
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBe(SECRET);
        });

        it("keeps the supply when the wake-up never landed, and honours it once the wait times out", async () => {
            expect.assertions(4);

            const reference = createReferenceHost();
            const { advanceClock, store, discarded } = spyStore(undefined, reference);
            const { ctx, functions, rows } = await stagedThread("user-a", store, fakeAgents(new Error("dispatch down")), undefined, LONG_DEADLINE_MS);

            await expect(
                inTransaction(rows, () => call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })),
            ).resolves.toStrictEqual({
                resolved: true,
            });

            // Past the 15-minute default: the wait only ends at the request's deadline, so the value must still be there then.
            advanceClock(30 * 60 * 1000);

            await expect(call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                status: "supplied",
            });
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBe(SECRET);
            expect(discarded).toStrictEqual([]);
        });

        it("refuses a supply that a newer run reopened during the store write, discards its value, and leaves the newer request pending", async () => {
            expect.assertions(4);

            const reference = createReferenceHost();
            const { discarded, store } = spyStore(undefined, reference);
            const storing = deferred();
            const storeStarted = deferred();
            const gatedStore: SecretValueHost = {
                ...store,
                put: async (value, options) => {
                    storeStarted.resolve();
                    await storing.promise;

                    return store.put(value, options);
                },
            };
            const { caller, ctx, functions, rows } = await stagedThread("user-a", gatedStore);

            const supplying = call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            await storeStarted.promise;

            // A newer run reuses `call_1` while the older supply is still storing its value.
            await call(functions.agentOpenSecretRequest, ctx, {
                consumerTool: "charge",
                expiresAt: NOW + DEADLINE_MS,
                instanceId: "wf-2",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });

            storing.resolve();

            await expect(supplying).rejects.toMatchObject({ code: "CONFLICT" });
            expect(discarded).toHaveLength(1);
            expect(requestRow(rows)).toMatchObject({ instanceId: "wf-2", ref: null, status: "pending" });
            expect(caller.sent).toStrictEqual([]);
        });

        it("rejects an over-size value with PAYLOAD_TOO_LARGE and keeps the request pending", async () => {
            expect.assertions(5);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            await expect(call(functions.agentSupplySecret, ctx, { secret: "x".repeat(9000), threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "PAYLOAD_TOO_LARGE",
            });
            expect(caller.sent).toStrictEqual([]);
            expect(markerCount(rows)).toBe(1);
            expect(requestRow(rows)["status"]).toBe("pending");
            expect(puts).toHaveLength(0);
        });

        it("answers a supply for a pre-change thread (marker, no request row) with CONFLICT and stores nothing", async () => {
            expect.assertions(3);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            rows.set(REQUESTS, []);

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            expect(puts).toStrictEqual([]);
            expect(caller.sent).toStrictEqual([]);
        });
    });

    describe("a supply and the loop's timeout, in both orders", () => {
        it("honours a supply that landed before the loop settled the timeout", async () => {
            expect.assertions(3);

            const { store } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            // The wait timed out after the supply committed: settle reports the supply, not the timeout.
            await expect(call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                status: "supplied",
            });
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBe(SECRET);
            expect(requestRow(rows)["status"]).toBe("supplied");
        });

        it("refuses a supply that arrives after the timeout settled the request, with CONFLICT and nothing stored", async () => {
            expect.assertions(5);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            await expect(call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                status: "expired",
            });
            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            expect(puts).toStrictEqual([]);
            expect(caller.sent).toStrictEqual([]);
            expect(requestRow(rows)["status"]).toBe("expired");
        });
    });

    describe("agentSettleSecretRequest", () => {
        it("moves a pending request to expired once, and reports the same status on a replay", async () => {
            expect.assertions(2);

            const { ctx, functions } = await stagedThread("user-a");

            await call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" });

            await expect(call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                status: "expired",
            });
            await expect(
                call(functions.agentSettleSecretRequest, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_missing" }),
            ).resolves.toStrictEqual({
                status: "expired",
            });
        });
    });

    describe("a deployment with no secret store", () => {
        it("names the missing codegen wiring, not just the target, when a supply is refused", async () => {
            expect.assertions(1);

            // No `agentSecrets` on the ctx: codegen did not wire the store, which it does only for an app that imports the tool.
            const { ctx, functions } = await stagedThread("user-a");

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toThrow(
                REQUEST_SECRET_TOOL_PATTERN,
            );
        });
    });

    describe("a take or discard from a run that no longer owns the request", () => {
        it("neither takes nor discards the value a newer run was supplied under the same tool-call id", async () => {
            expect.assertions(4);

            const { store, discarded } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            // A newer run reuses `call_1`, reopens the request, and is supplied its own value.
            await call(functions.agentEnsureThread, ctx, { agent: "support", instanceId: "wf-2", key: "t-1", onConcurrentRun: "replace", owner: "user-a" });
            await call(functions.agentOpenSecretRequest, ctx, {
                consumerTool: "charge",
                expiresAt: NOW + DEADLINE_MS,
                instanceId: "wf-2",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });
            await call(functions.agentAppendMessage, ctx, {
                content: 'Awaiting a secret for tool "requestKey".',
                messageKey: "wf-2:secret:call_1",
                role: "tool",
                status: "awaiting_secret",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });
            await call(functions.agentSupplySecret, ctx, { secret: "newer-value", threadKey: "t-1", toolCallId: "call_1" });

            // The older run's delayed discard and take arrive only now.
            await call(functions.agentDiscardSecret, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" });

            await expect(
                take(functions, ctx, {
                    claimant: "tool:charge:call_2",
                    consumerCallId: "call_2",
                    instanceId: "wf-1",
                    threadKey: "t-1",
                    toolCallId: "call_1",
                }),
            ).resolves.toBeUndefined();

            expect(discarded).toHaveLength(1);
            expect(requestRow(rows)).toMatchObject({ instanceId: "wf-2", status: "supplied" });
            await expect(
                take(functions, ctx, {
                    claimant: "tool:charge:call_2",
                    consumerCallId: "call_2",
                    instanceId: "wf-2",
                    threadKey: "t-1",
                    toolCallId: "call_1",
                }),
            ).resolves.toBe("newer-value");
        });
    });

    describe("agentDeclineSecret", () => {
        it("retires the marker and wakes the run with an empty payload, storing nothing", async () => {
            expect.assertions(5);

            const { store, puts } = spyStore();
            const { caller, ctx, functions, rows } = await stagedThread("user-a", store);

            await expect(call(functions.agentDeclineSecret, ctx, { threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({ resolved: true });
            expect(caller.sent).toStrictEqual([{ event: { payload: {}, type: "agent-secret:call_1" }, id: "wf-1" }]);
            expect(markerCount(rows)).toBe(0);
            expect(requestRow(rows)["status"]).toBe("declined");
            expect(puts).toStrictEqual([]);
        });

        it("keeps the committed decline when the wake-up fails to send", async () => {
            expect.assertions(3);

            const caller = ackLostAgents();
            const { ctx, functions, rows } = await stagedThread("user-a", spyStore().store, caller);

            await expect(inTransaction(rows, () => call(functions.agentDeclineSecret, ctx, { threadKey: "t-1", toolCallId: "call_1" }))).resolves.toStrictEqual(
                { resolved: true },
            );
            expect(caller.sent).toHaveLength(1);
            expect(requestRow(rows)["status"]).toBe("declined");
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

        it("lets exactly one of a decline and a supply win", async () => {
            expect.assertions(4);

            const { store, puts } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentDeclineSecret, ctx, { threadKey: "t-1", toolCallId: "call_1" });

            await expect(call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({
                code: "CONFLICT",
            });
            await expect(call(functions.agentDeclineSecret, ctx, { threadKey: "t-1", toolCallId: "call_1" })).rejects.toMatchObject({ code: "CONFLICT" });
            expect(puts).toStrictEqual([]);
            expect(requestRow(rows)["status"]).toBe("declined");
        });
    });

    describe("agentOpenSecretRequest", () => {
        it("creates no second row when a paused call replays", async () => {
            expect.assertions(2);

            const { ctx, functions, rows } = await stagedThread("user-a");

            await call(functions.agentOpenSecretRequest, ctx, {
                consumerTool: "charge",
                expiresAt: NOW + DEADLINE_MS,
                instanceId: "wf-1",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });

            expect(rows.get(REQUESTS)).toHaveLength(1);
            expect(requestRow(rows)["status"]).toBe("pending");
        });

        it("starts a new request for a later run that reuses a finished run's tool-call id, discarding the old value", async () => {
            expect.assertions(5);

            const { store, discarded, puts } = spyStore();
            const caller = fakeAgents();
            const { ctx, functions, rows } = await stagedThread("user-a", store, caller);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            // The first run ended without consuming the value. A second run takes the thread and reuses `call_1`.
            await call(functions.agentEnsureThread, ctx, { agent: "support", instanceId: "wf-2", key: "t-1", onConcurrentRun: "replace", owner: "user-a" });
            await call(functions.agentOpenSecretRequest, ctx, {
                consumerTool: "charge",
                expiresAt: NOW + DEADLINE_MS,
                instanceId: "wf-2",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });
            await call(functions.agentAppendMessage, ctx, {
                content: 'Awaiting a secret for tool "requestKey".',
                messageKey: "wf-2:secret:call_1",
                role: "tool",
                status: "awaiting_secret",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });

            expect(discarded).toHaveLength(1);
            expect(requestRow(rows)["status"]).toBe("pending");

            await expect(call(functions.agentSupplySecret, ctx, { secret: "second-value", threadKey: "t-1", toolCallId: "call_1" })).resolves.toStrictEqual({
                resolved: true,
            });
            expect(puts).toStrictEqual([SECRET, "second-value"]);
            expect(caller.sent.at(-1)?.id).toBe("wf-2");
        });

        it("does not reopen a request that was already answered", async () => {
            expect.assertions(2);

            const { store } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });
            await call(functions.agentOpenSecretRequest, ctx, {
                consumerTool: "charge",
                expiresAt: NOW + 2 * DEADLINE_MS,
                instanceId: "wf-1",
                threadKey: "t-1",
                toolCallId: "call_1",
                toolName: "requestKey",
            });

            expect(requestRow(rows)["status"]).toBe("supplied");
            expect(requestRow(rows)["expiresAt"]).toBe(NOW + DEADLINE_MS);
        });
    });

    describe("agentTakeSecret and agentDiscardSecret", () => {
        it("binds the declared consumer's claimant, lets it re-take, and refuses any other claimant", async () => {
            expect.assertions(5);

            const { store } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            const consumed = (claimant: string, consumerCallId: string, threadKey = "t-1"): Promise<unknown> =>
                take(functions, ctx, { instanceId: "wf-1", claimant, consumerCallId, threadKey, toolCallId: "call_1" });

            await expect(consumed("tool:charge:call_2", "call_2")).resolves.toBe(SECRET);
            await expect(consumed("tool:charge:call_2", "call_2")).resolves.toBe(SECRET);
            await expect(consumed("tool:other:call_3", "call_3")).resolves.toBeUndefined();
            await expect(consumed("tool:charge:call_2", "call_2", "t-other")).resolves.toBeUndefined();

            expect(requestRow(rows)["status"]).toBe("supplied");
        });

        it("refuses a claimant that only starts with the consumer's name, and does not bind the host", async () => {
            expect.assertions(3);

            const { store } = spyStore();
            const { ctx, functions } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            // A longer step name must not pass the consumer check: the claimant has to be exactly this call's step.
            await expect(
                take(functions, ctx, {
                    instanceId: "wf-1",
                    claimant: "tool:charge:call_2:extra",
                    consumerCallId: "call_2",
                    threadKey: "t-1",
                    toolCallId: "call_1",
                }),
            ).resolves.toBeUndefined();
            // The refusal bound nothing, so the declared consumer still takes the value.
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBe(SECRET);
            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_9", consumerCallId: "call_9", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBeUndefined();
        });

        it("discards the value, marks the request consumed, and stays idempotent", async () => {
            expect.assertions(3);

            const { store } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBe(SECRET);

            await call(functions.agentDiscardSecret, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" });
            await call(functions.agentDiscardSecret, ctx, { instanceId: "wf-1", threadKey: "t-1", toolCallId: "call_1" });

            await expect(
                take(functions, ctx, { instanceId: "wf-1", claimant: "tool:charge:call_2", consumerCallId: "call_2", threadKey: "t-1", toolCallId: "call_1" }),
            ).resolves.toBeUndefined();
            expect(requestRow(rows)["status"]).toBe("consumed");
        });

        it("exposes the take and discard mutations internally only", () => {
            expect.assertions(2);

            const { functions } = agentComponent();

            expect((functions.agentTakeSecret as { visibility?: string }).visibility).toBe("internal");
            expect((functions.agentDiscardSecret as { visibility?: string }).visibility).toBe("internal");
        });
    });

    describe("agentSecretRequests", () => {
        it("lists the thread's requests to its owner, with status and deadline but never the ref or the value", async () => {
            expect.assertions(4);

            const { store } = spyStore();
            const { ctx, functions, rows } = await stagedThread("user-a", store);

            await call(functions.agentSupplySecret, ctx, { secret: SECRET, threadKey: "t-1", toolCallId: "call_1" });

            const listed = await call(functions.agentSecretRequests, ctx, { threadKey: "t-1" });
            const ref = requestRow(rows)["ref"] as string;

            expect(listed).toStrictEqual([{ createdAt: NOW, expiresAt: NOW + DEADLINE_MS, status: "supplied", toolCallId: "call_1", toolName: "requestKey" }]);
            expect(JSON.stringify(listed)).not.toContain(ref);
            expect(JSON.stringify(listed)).not.toContain(SECRET);
            expect(JSON.stringify(listed)).not.toContain("ref");
        });

        it("lists the label the model gave the request, so the owner can see what is asked for", async () => {
            expect.assertions(1);

            const { ctx, functions } = await stagedThread("user-a", undefined, fakeAgents(), "Stripe live secret key");

            await expect(call(functions.agentSecretRequests, ctx, { threadKey: "t-1" })).resolves.toStrictEqual([
                {
                    createdAt: NOW,
                    expiresAt: NOW + DEADLINE_MS,
                    label: "Stripe live secret key",
                    status: "pending",
                    toolCallId: "call_1",
                    toolName: "requestKey",
                },
            ]);
        });

        it("refuses an anonymous caller, an ownerless thread, and another owner", async () => {
            expect.assertions(3);

            const owned = await stagedThread("user-a");
            const ownerless = await stagedThread(undefined);

            await expect(call(owned.functions.agentSecretRequests, { ...owned.ctx, auth: {} }, { threadKey: "t-1" })).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
            await expect(
                call(ownerless.functions.agentSecretRequests, { ...ownerless.ctx, auth: { userId: "user-a" } }, { threadKey: "t-1" }),
            ).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
            await expect(call(owned.functions.agentSecretRequests, { ...owned.ctx, auth: { userId: "user-b" } }, { threadKey: "t-1" })).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
        });
    });

    describe("the plaintext argument", () => {
        it("is named `secret`, the name the request log masks", () => {
            expect.assertions(1);

            const { args } = agentComponent().functions.agentSupplySecret as unknown as { args: Record<string, unknown> };

            expect(Object.keys(args)).toContain("secret");
        });
    });
});
