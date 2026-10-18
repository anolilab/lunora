/**
 * Real-workerd coverage for the secret request table: the pending row a paused
 * `requestSecretTool` call writes, its idempotent replay, the expiry that settles
 * it, and the owner-gated list, against the component's functions over a Durable
 * Object's SQLite (see `./test-worker.ts`). The table's unique `byThreadCall` index
 * and its reads are workerd's, not the node double's.
 *
 * Only runs with `LUNORA_WORKERD_TESTS=1`; `pnpm --filter "@lunora/agent" run test`
 * covers the `node` project alone.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const OWNER = "user-a";
const THREAD = "thread-1";
const DEADLINE_MS = 60_000;

interface SecretRequest {
    createdAt: number;
    expiresAt: number;
    status: string;
    toolCallId: string;
    toolName: string;
}

/** A fresh store holding a thread owned by `OWNER`, paused on `call_1` for the `charge` consumer. */
const pausedStore = async (name: string) => {
    const stub = env.AGENT_STORE.get(env.AGENT_STORE.idFromName(name));
    const call = async (fn: string, args: Record<string, unknown>, auth?: { userId?: string }): Promise<unknown> =>
        JSON.parse(await stub.call(fn, args, auth ?? {})) as unknown;
    const open = (): Promise<unknown> =>
        call("agentOpenSecretRequest", {
            consumerTool: "charge",
            expiresAt: Date.now() + DEADLINE_MS,
            instanceId: "wf-1",
            threadKey: THREAD,
            toolCallId: "call_1",
            toolName: "requestKey",
        });

    await call("agentEnsureThread", { agent: "support", instanceId: "wf-1", key: THREAD, owner: OWNER });

    return {
        list: (auth?: { userId?: string }) => call("agentSecretRequests", { threadKey: THREAD }, auth ?? { userId: OWNER }) as Promise<SecretRequest[]>,
        open,
        settle: () => call("agentSettleSecretRequest", { threadKey: THREAD, toolCallId: "call_1" }),
    };
};

describe("secret request table on real workerd storage", () => {
    it("writes one pending row per pause, however often the pause replays", async () => {
        expect.assertions(4);

        const store = await pausedStore("replay");

        await store.open();
        await store.open();

        const listed = await store.list();

        expect(listed).toHaveLength(1);
        expect(listed[0]?.status).toBe("pending");
        expect(listed[0]?.toolName).toBe("requestKey");
        expect(listed[0]?.toolCallId).toBe("call_1");
    });

    it("settles an unanswered request to expired once, and reports the same outcome on a replay", async () => {
        expect.assertions(3);

        const store = await pausedStore("settle");

        await store.open();

        await expect(store.settle()).resolves.toStrictEqual({ status: "expired" });
        await expect(store.settle()).resolves.toStrictEqual({ status: "expired" });

        const [row] = await store.list();

        expect(row?.status).toBe("expired");
    });

    it("refuses an anonymous reader of the list, as it refuses an ownerless thread", async () => {
        expect.assertions(1);

        const store = await pausedStore("anonymous");

        await store.open();

        await expect(store.list({})).rejects.toThrow("only the thread's owner can list its secret requests");
    });
});
