/**
 * Real-workerd coverage for the approvals inbox (`agentPendingApprovals`): owner
 * scoping, the current-instance filter, the `limit` clamp and newest-first thread
 * order, plus the per-thread prefix read on `byMessageKey`. Runs the component's
 * own functions over a Durable Object's SQLite (see `./test-worker.ts`), so the
 * `byOwnerStatus` index and the `gte`/`lt` range are workerd's, not a double's.
 *
 * Only runs with `LUNORA_WORKERD_TESTS=1`; `pnpm --filter "@lunora/agent" run test`
 * covers the `node` project alone.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import approvalMarkerFields from "../approval-fixtures";

interface Approval {
    agent: string;
    instanceId: string;
    threadKey: string;
    threadUpdatedAt: number;
    toolCallId: string;
}

/** A fresh store under its own name, so no suite shares SQLite state with another. */
const store = (name: string) => {
    const stub = env.AGENT_STORE.get(env.AGENT_STORE.idFromName(name));
    const call = async (fn: string, args: Record<string, unknown>, auth?: { userId?: string }): Promise<unknown> =>
        JSON.parse(await stub.call(fn, args, auth)) as unknown;

    return {
        /**
         * Start a run on `key` as `instanceId` (owned by `owner`), park it on one approval marker, and leave it
         * `awaiting_input`. A paused thread counts as in flight, so a takeover of an earlier instance passes `replace`.
         */
        park: async (key: string, owner: string | undefined, instanceId: string, toolCallId: string, takeOver = false): Promise<void> => {
            await call("agentEnsureThread", {
                agent: "support",
                instanceId,
                key,
                ...(owner === undefined ? {} : { owner }),
                ...(takeOver ? { onConcurrentRun: "replace" } : {}),
            });
            await call("agentAppendMessage", { ...approvalMarkerFields({ instanceId, toolCallId }), threadKey: key });
            await call("agentPatchThread", { key, status: "awaiting_input" });
        },
        /** Pause `key` on a secret request (`awaiting_secret`), which leaves the thread `awaiting_input` with no approval. */
        pauseForSecret: async (key: string, owner: string, instanceId: string): Promise<void> => {
            await call("agentEnsureThread", { agent: "support", instanceId, key, owner });
            await call("agentAppendMessage", {
                content: "Awaiting a secret.",
                messageKey: `${instanceId}:secret:call_secret`,
                role: "tool",
                status: "awaiting_secret",
                threadKey: key,
                toolCallId: "call_secret",
                toolName: "charge",
            });
            await call("agentPatchThread", { key, status: "awaiting_input" });
        },
        /** The inbox as `userId` sees it; no `userId` is an anonymous caller. */
        inbox: async (userId?: string, limit?: number): Promise<Approval[]> =>
            (await call("agentPendingApprovals", limit === undefined ? {} : { limit }, userId === undefined ? {} : { userId })) as Approval[],
        call,
    };
};

describe("approvals inbox on real workerd storage", () => {
    it("lists the caller's own paused approvals and never another owner's", async () => {
        const { inbox, park } = store("owner");

        await park("t-a", "user-a", "wf-a", "call_a");
        await park("t-b", "user-b", "wf-b", "call_b");

        const pending = await inbox("user-a");

        expect(pending.map((item) => item.threadKey)).toStrictEqual(["t-a"]);
        expect(pending[0]).toMatchObject({ agent: "support", instanceId: "wf-a", toolCallId: "call_a" });
    });

    it("returns nothing for an anonymous caller and never an ownerless thread", async () => {
        const { inbox, park } = store("anonymous");

        await park("t-open", undefined, "wf-open", "call_open");

        await expect(inbox()).resolves.toStrictEqual([]);
        await expect(inbox("user-a")).resolves.toStrictEqual([]);
    });

    it("excludes a marker minted by an earlier instance of the thread", async () => {
        const { inbox, park } = store("stale");

        await park("t-1", "user-a", "wf-1", "call_old");
        // wf-2 takes the thread over, leaving wf-1's marker behind.
        await park("t-1", "user-a", "wf-2", "call_new", true);

        const pending = await inbox("user-a");

        expect(pending.map((item) => item.toolCallId)).toStrictEqual(["call_new"]);
    });

    it("reads only the current instance's markers, however long the thread's history", async () => {
        const { call, inbox, park } = store("prefix");

        await park("t-long", "user-a", "wf-1", "call_real");
        // Keys either side of the `<instanceId>:approval:` prefix, all still `awaiting_approval`.
        await call("agentAppendMessage", {
            ...approvalMarkerFields({ instanceId: "wf-1", messageKey: "wf-1:approval", toolCallId: "decoy_bare" }),
            threadKey: "t-long",
        });
        await call("agentAppendMessage", {
            ...approvalMarkerFields({ instanceId: "wf-1", messageKey: "wf-1:approval;z", toolCallId: "decoy_semicolon" }),
            threadKey: "t-long",
        });
        for (let index = 0; index < 30; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- seq is allocated in append order
            await call("agentAppendMessage", { content: `m${String(index)}`, messageKey: `m-${String(index)}`, role: "user", threadKey: "t-long" });
        }

        const pending = await inbox("user-a");

        expect(pending.map((item) => item.toolCallId)).toStrictEqual(["call_real"]);
    });

    it("is not starved by newer secret-paused threads that hold no approval", async () => {
        const { inbox, park, pauseForSecret } = store("secret-starve");

        await park("t-approval", "user-a", "wf-approval", "call_approval");
        // More secret-paused threads than the default page, all newer than the approval.
        for (let index = 0; index < 60; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- seeding order decides which threads are newest
            await pauseForSecret(`t-secret-${String(index)}`, "user-a", `wf-secret-${String(index)}`);
        }

        const pending = await inbox("user-a");

        expect(pending.map((item) => item.toolCallId)).toStrictEqual(["call_approval"]);
    });

    it("hides a marker past its deadline and keeps one still open", async () => {
        const { call, inbox } = store("expiry");
        const markers = [
            { expiresAt: Date.now() + 60_000, toolCallId: "call_open" },
            { expiresAt: Date.now() - 1000, toolCallId: "call_lapsed" },
        ];

        for (const { expiresAt, toolCallId } of markers) {
            const key = `t-${toolCallId}`;
            const instanceId = `wf-${toolCallId}`;

            // eslint-disable-next-line no-await-in-loop -- one thread per marker keeps the seeding order explicit
            await call("agentEnsureThread", { agent: "support", instanceId, key, owner: "user-a" });
            // eslint-disable-next-line no-await-in-loop -- the marker must exist before its thread is parked
            await call("agentAppendMessage", { ...approvalMarkerFields({ expiresAt, instanceId, toolCallId }), threadKey: key });
            // eslint-disable-next-line no-await-in-loop -- the thread is paused only once its marker is written
            await call("agentPatchThread", { key, status: "awaiting_input" });
        }

        const pending = await inbox("user-a");

        expect(pending.map((item) => item.toolCallId)).toStrictEqual(["call_open"]);
    });

    it("clamps the limit to [1, 200] and returns threads newest first", async () => {
        const { inbox, park } = store("limit");

        // One more than the ceiling, so an unclamped limit would return all of them.
        for (let index = 0; index < 205; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- one thread per iteration keeps the seeding order deterministic
            await park(`t-${String(index).padStart(3, "0")}`, "user-a", `wf-${String(index)}`, `call_${String(index)}`);
        }

        const defaulted = await inbox("user-a");
        const capped = await inbox("user-a", 1000);
        const floored = await inbox("user-a", 0);

        // Thread i is seeded i-th, so the newest `count` are the last `count` keys, highest first.
        const newest = (count: number): string[] => Array.from({ length: count }, (_, offset) => `t-${String(204 - offset).padStart(3, "0")}`);
        const keys = (items: Approval[]): string[] => items.map((item) => item.threadKey);

        expect(keys(defaulted)).toStrictEqual(newest(50));
        expect(keys(capped)).toStrictEqual(newest(200));
        expect(keys(floored)).toStrictEqual(newest(1));
    }, 120_000); // seeding 205 threads over RPC takes ~25s, close to the 30s default
});
