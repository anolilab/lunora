import { afterEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { cleanupDatabases, gate, setup, TestShard } from "./_helpers/delivery-authorization";

const request = (user: string, path: string, mutationId: string) =>
    new Request("https://shard.internal/rpc", {
        method: "POST",
        headers: { "x-lunora-userid": user, "x-lunora-identity": JSON.stringify({ subject: user }), "x-lunora-mutation-id": mutationId },
        body: JSON.stringify({ functionPath: path, args: {} }),
    });

class OverlappingMutationShard extends TestShard {
    public readonly action = { entered: gate(), release: gate() };
    public readonly mutation = { entered: gate(), release: gate() };
    private readonly mutations = new Set(["messages:mutation"]);
    public override async handleRpc(path: string): Promise<unknown> {
        this.rpcRuns += 1;
        if (path === "messages:action") {
            this.action.entered.resolve();
            await this.action.release.promise;
            return "bob-action";
        }
        return this.runInTransaction(async () => {
            this.mutation.entered.resolve();
            await this.mutation.release.promise;
            const value = "alice-mutation";
            this.commitMutationBookkeeping(value);
            return value;
        });
    }
    protected override isMutationFunction(path: string): boolean {
        return this.mutations.has(path);
    }
}

const transactionalState = (test: ReturnType<typeof setup>, committed: Record<string, unknown>[][]): ShardDOState =>
    ({
        ...test.state,
        storage: {
            ...test.state.storage,
            transaction: async <T>(run: () => Promise<T>): Promise<T> => {
                test.database.sql.exec("BEGIN");

                try {
                    const result = await run();
                    committed.push(test.database.raw("SELECT identity, mutation_id, scope, epoch FROM __lunora_delivery_receipt ORDER BY identity"));

                    test.database.sql.exec("COMMIT");

                    return result;
                } catch (error) {
                    test.database.sql.exec("ROLLBACK");

                    throw error;
                }
            },
        },
    }) as ShardDOState;

describe("delivery mutation request scope", () => {
    afterEach(cleanupDatabases);

    it("commits the mutation receipt under its captured caller after an older action resumes", async () => {
        expect.hasAssertions();

        const test = setup();
        const committed: Record<string, unknown>[][] = [];
        const state = transactionalState(test, committed);
        const shard = new OverlappingMutationShard(
            state,
            {},
            {
                deliveryAuthorization: async ({ identity }) => {
                    return { scope: String(identity.userId), epoch: identity.userId === "alice" ? 3 : 8 };
                },
            },
        );
        const action = shard.fetch(request("bob", "messages:action", "bob-id"));
        await shard.action.entered.promise;
        const mutation = shard.fetch(request("alice", "messages:mutation", "alice-id"));
        await shard.mutation.entered.promise;
        shard.action.release.resolve();

        const actionResponse = await action;

        expect(actionResponse.status).toBe(200);

        shard.mutation.release.resolve();

        const mutationResponse = await mutation;

        expect(mutationResponse.status).toBe(200);
        expect(committed).toEqual([
            [
                { identity: "alice", mutation_id: "alice-id", scope: "alice", epoch: 3 },
                { identity: "bob", mutation_id: "bob-id", scope: "bob", epoch: 8 },
            ],
        ]);

        const replay = await shard.fetch(request("alice", "messages:mutation", "alice-id"));

        expect(replay.status).toBe(200);
        await expect(replay.json()).resolves.toMatchObject({ result: "alice-mutation" });

        const actionReplay = await shard.fetch(request("bob", "messages:action", "bob-id"));

        expect(actionReplay.status).toBe(200);
        await expect(actionReplay.json()).resolves.toMatchObject({ result: "bob-action" });
        expect(shard.rpcRuns).toBe(2);
    });

    it("keeps a pending sibling's receipt separate from the mutation's commit", async () => {
        expect.hasAssertions();

        const test = setup();
        const committed: Record<string, unknown>[][] = [];
        const shard = new OverlappingMutationShard(
            transactionalState(test, committed),
            {},
            {
                deliveryAuthorization: async ({ identity }) => {
                    return { scope: String(identity.userId), epoch: identity.userId === "alice" ? 3 : 8 };
                },
            },
        );
        const mutation = shard.fetch(request("alice", "messages:mutation", "alice-id"));
        await shard.mutation.entered.promise;
        const action = shard.fetch(request("bob", "messages:action", "bob-id"));
        await shard.action.entered.promise;
        shard.mutation.release.resolve();

        const mutationResponse = await mutation;

        expect(mutationResponse.status).toBe(200);
        expect(committed).toEqual([[{ identity: "alice", mutation_id: "alice-id", scope: "alice", epoch: 3 }]]);

        shard.action.release.resolve();

        const actionResponse = await action;

        expect(actionResponse.status).toBe(200);
        expect(test.database.raw("SELECT identity, mutation_id, result_json FROM __idempotency ORDER BY identity")).toEqual([
            { identity: "alice", mutation_id: "alice-id", result_json: '"alice-mutation"' },
            { identity: "bob", mutation_id: "bob-id", result_json: '"bob-action"' },
        ]);
        expect(test.database.raw("SELECT identity, scope, epoch FROM __lunora_delivery_receipt ORDER BY identity")).toEqual([
            { identity: "alice", scope: "alice", epoch: 3 },
            { identity: "bob", scope: "bob", epoch: 8 },
        ]);
    });
});
