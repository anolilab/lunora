import { AsyncLocalStorage } from "node:async_hooks";

import { readRequestLog } from "@lunora/observability";
import { runShardMigrations } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The caller-CLAIMS half of the per-request scope, over the real dispatch path.
 *
 * `userId` alone does not describe a caller: RLS grants roles from the claims
 * object (`readIdentityRoles` in `@lunora/server`), and `ctx.auth.getIdentity()`
 * returns it. A mutation queued at the replay gate is admitted long after a
 * sibling `fetch()`'s prologue has overwritten the shared `currentRequest*`
 * fields, so anything the gate does not re-pin is the sibling's — which for the
 * claims means the queued mutation evaluates RLS as whoever ran while it waited.
 */

/** One caller's identity headers, kept next to the claims they encode. */
interface Caller {
    claims: Record<string, unknown>;
    userId: string;
}

const ADMIN: Caller = { claims: { role: "admin", tenant: "acme" }, userId: "userAdmin" };
const MEMBER: Caller = { claims: { role: "member", tenant: "widgets" }, userId: "userMember" };
const VIEWER: Caller = { claims: { role: "viewer", tenant: "zinc" }, userId: "userViewer" };

/** What the handler saw on `this` at the moment it ran. */
interface Observation {
    functionPath: string;
    identity: Record<string, unknown> | undefined;
    userId: string | undefined;
}

/**
 * A shard whose handler records the caller context the generated `buildCtx`
 * reads (`getCurrentUserId` / `getCurrentIdentity`), and which can park a named
 * function until the test releases it.
 *
 * `messages:send` and `messages:update` are mutations — the kind that takes the
 * `runSerialized` replay gate; `messages:poll` is an action, which does not.
 */
class ScopeObservingShard extends ShardDO {
    public readonly observed: Observation[] = [];

    public readonly parks = new Map<string, Promise<void>>();

    public override async handleRpc(functionPath: string): Promise<unknown> {
        const park = this.parks.get(functionPath);

        if (park !== undefined) {
            await park;
        }

        this.observed.push({ functionPath, identity: this.getCurrentIdentity(), userId: this.getCurrentUserId() });

        if (functionPath.endsWith(":boom")) {
            throw new Error("boom");
        }

        return { ran: functionPath };
    }

    /** Park `functionPath` inside the handler until the returned callback runs. */
    public park(functionPath: string): () => void {
        let release: () => void = () => {};

        this.parks.set(
            functionPath,
            new Promise<void>((resolve) => {
                release = resolve;
            }),
        );

        return release;
    }

    // eslint-disable-next-line class-methods-use-this -- pure predicate over the path, mirroring the codegen override
    protected override isMutationFunction(functionPath: string): boolean {
        return functionPath === "messages:send" || functionPath === "messages:update";
    }
}

const makeState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets() {
            return [];
        },
        storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
    };
};

/**
 * A `blockConcurrencyWhile` double that actually serializes, so the second
 * mutation really queues instead of interleaving. `AsyncLocalStorage` marks the
 * callback's own await chain so a NESTED `runSerialized` (what
 * `runInTransaction` does) runs in place rather than deadlocking on the gate its
 * own caller holds — workerd's behaviour. Mirrors the double in
 * `shard-do.idempotency.test.ts`.
 */
const makeSerializedState = (database: ReturnType<typeof createSqliteExec>): ShardDOState => {
    let queue: Promise<void> = Promise.resolve();
    const insideGate = new AsyncLocalStorage<true>();

    return {
        ...makeState(database),
        blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => {
            if (insideGate.getStore() === true) {
                return callback();
            }

            const previous = queue;
            let release: () => void = () => {};

            queue = new Promise<void>((resolve) => {
                release = resolve;
            });

            await previous;

            try {
                return await insideGate.run(true, callback);
            } finally {
                release();
            }
        },
    };
};

const rpcRequest = (functionPath: string, mutationId: string, caller: Caller): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-lunora-identity": JSON.stringify(caller.claims),
            "x-lunora-mutation-id": mutationId,
            "x-lunora-userid": caller.userId,
        },
        method: "POST",
    });

/** Let every already-queued microtask and timer turn run. */
const tick = async (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

describe("shardDO per-request scope (caller claims)", () => {
    it("runs a gate-queued mutation under ITS OWN claims, not those of whoever ran while it waited", async () => {
        expect.assertions(2);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ScopeObservingShard(makeSerializedState(database), {});

            // The admin's mutation takes the gate and parks inside it.
            const releaseAdmin = shard.park("messages:send");
            const adminMutation = shard.fetch(rpcRequest("messages:send", "m-admin", ADMIN));

            await tick();

            // The member's mutation runs its prologue (stamping its own claims)
            // and then queues behind the gate.
            const memberMutation = shard.fetch(rpcRequest("messages:update", "m-member", MEMBER));

            await tick();

            // A viewer's ACTION does not take the gate. Its prologue overwrites
            // the shared fields with the viewer's claims and it parks there, so
            // the claims sitting on `this` when the gate finally admits the
            // member's queued mutation are the viewer's.
            const releaseViewer = shard.park("messages:poll");
            const viewerAction = shard.fetch(rpcRequest("messages:poll", "m-viewer", VIEWER));

            await tick();

            releaseAdmin();
            await adminMutation;
            await memberMutation;

            releaseViewer();
            await viewerAction;

            const member = shard.observed.find((entry) => entry.functionPath === "messages:update");

            expect(member?.userId).toBe(MEMBER.userId);
            // Before the fix: the viewer's claims carried under the member's
            // userId — so RLS grants the member whatever role the viewer holds.
            expect(member?.identity).toStrictEqual(MEMBER.claims);
        } finally {
            database.close();
        }
    });

    it("files a FAILED dispatch's request-log row under the caller that made it", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            runShardMigrations(database.sql, messagesSchema);

            const shard = new ScopeObservingShard(makeState(database), {});

            // The admin's action parks, then throws.
            const releaseAdmin = shard.park("messages:boom");
            const failing = shard.fetch(rpcRequest("messages:boom", "m-boom", ADMIN));

            await tick();

            // The viewer's dispatch runs its prologue — overwriting the shared
            // fields — and parks there, so the failure below resolves while the
            // viewer owns them.
            const releaseViewer = shard.park("messages:poll");
            const viewerAction = shard.fetch(rpcRequest("messages:poll", "m-viewer", VIEWER));

            await tick();

            releaseAdmin();

            const response = await failing;

            expect(response.status).toBe(500);

            releaseViewer();
            await viewerAction;

            const row = readRequestLog(database.sql).find((entry) => entry.functionPath === "messages:boom");

            expect(row?.outcome).toBe("error");
            // Before the fix: the viewer — a principal that never made this call,
            // in a durable row that also ships to Logpush/SIEM.
            expect(row?.userId).toBe(ADMIN.userId);
        } finally {
            database.close();
        }
    });
});
