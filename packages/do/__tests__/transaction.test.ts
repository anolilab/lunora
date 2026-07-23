import { ConflictError } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

type ExecMock = ((query: string) => unknown) & {
    mock: { calls: unknown[][] };
    mockImplementation: (impl: (query: string) => unknown) => ExecMock;
};

type TransactionMock = (<R>(closure: () => Promise<R>) => Promise<R>) & { mock: { calls: unknown[][] } };

interface FakeState extends ShardDOState {
    sockets: never[];
    storage: { sql: { exec: ExecMock }; transaction?: TransactionMock };
}

/** A `state.storage.transaction` double mirroring the platform: run the closure, propagate (the platform rolls back a thrown closure). */
const fakeTransaction = (): TransactionMock =>
    vi.fn<<R>(closure: () => Promise<R>) => Promise<R>>(async <R>(closure: () => Promise<R>): Promise<R> => closure()) as TransactionMock;

const createFakeState = (sqlExec: ExecMock = vi.fn<(query: string) => unknown>(), transaction: TransactionMock | undefined = fakeTransaction()): FakeState => {
    const state: FakeState = {
        acceptWebSocket: vi.fn<ShardDOState["acceptWebSocket"]>(),
        getWebSockets: vi.fn<ShardDOState["getWebSockets"]>(() => []),
        id: { name: "test-shard" },
        sockets: [],
        storage: { sql: { exec: sqlExec }, transaction },
    };

    return state;
};

class TestShardDO extends ShardDO {
    public constructor(state: ShardDOState) {
        super(state, {});
    }

    // eslint-disable-next-line class-methods-use-this -- override stub; transaction tests never dispatch an RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    public callRunInTransaction<T>(handler: () => Promise<T> | T): Promise<T> {
        return this.runInTransaction(handler);
    }

    public async errorResponse(error: unknown): Promise<Response> {
        try {
            throw error;
        } catch (error_) {
            // Reach the private mapper through the public fetch path.
            const request = new Request("https://shard.invalid/rpc", {
                body: JSON.stringify({ functionPath: "noop" }),
                method: "POST",
            });

            // Override handleRpc for this single call so it raises our error.
            const original = this.handleRpc.bind(this);

            this.handleRpc = async (): Promise<unknown> => {
                throw error_;
            };

            try {
                return await this.fetch(request);
            } finally {
                this.handleRpc = original;
            }
        }
    }
}

describe("shardDO.runInTransaction", () => {
    let exec: ExecMock;
    let transaction: TransactionMock;
    let shard: TestShardDO;

    beforeEach(() => {
        exec = vi.fn<(query: string) => unknown>();
        transaction = fakeTransaction();
        shard = new TestShardDO(createFakeState(exec, transaction));
    });

    it("runs the handler inside state.storage.transaction and returns its result", async () => {
        expect.assertions(2);

        const result = await shard.callRunInTransaction(() => 42);

        expect(result).toBe(42);
        // Atomicity/rollback come from the platform primitive, NOT raw BEGIN/COMMIT
        // SQL (which workerd forbids inside a Durable Object).
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("propagates a thrown error (the platform transaction rolls back)", async () => {
        expect.assertions(2);

        const boom = new Error("boom");

        await expect(
            shard.callRunInTransaction(() => {
                throw boom;
            }),
        ).rejects.toBe(boom);

        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("re-throws ConflictError through the transaction", async () => {
        expect.assertions(2);

        const conflict = new ConflictError("stale version");

        await expect(
            shard.callRunInTransaction(() => {
                throw conflict;
            }),
        ).rejects.toBe(conflict);

        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("falls back to a bare handler call when storage.transaction is unavailable (test doubles)", async () => {
        expect.assertions(1);

        const bareState = createFakeState();
        delete bareState.storage.transaction;
        const bareShard = new TestShardDO(bareState);

        await expect(bareShard.callRunInTransaction(() => 7)).resolves.toBe(7);
    });

    it("refuses nested transactions with NESTED_TRANSACTION code", async () => {
        expect.assertions(1);

        await expect(
            shard.callRunInTransaction(async () => {
                await shard.callRunInTransaction(() => 1);
            }),
        ).rejects.toMatchObject({ code: "NESTED_TRANSACTION", name: "LunoraError", status: 500 });
    });

    it("clears transactionDepth in the finally branch so a second tx can run", async () => {
        expect.assertions(2);

        await expect(shard.callRunInTransaction(() => 1)).resolves.toBe(1);
        // The second call only succeeds if `transactionDepth` was cleared after the
        // first (otherwise it trips the nested-transaction guard).
        await expect(shard.callRunInTransaction(() => 2)).resolves.toBe(2);
    });

    it("conflictError carries code / status / name as own properties", () => {
        expect.assertions(5);

        const error = new ConflictError();

        expect(error.code).toBe("CONFLICT");
        expect(error.status).toBe(409);
        expect(error.name).toBe("ConflictError");
        expect(error.message).toBe("Optimistic concurrency conflict");
        // Defaults to the generic `conflict` kind so a bare throw isn't mistaken
        // for OCC write contention by the metrics layer.
        expect(error.kind).toBe("conflict");
    });

    it("conflictError records the discriminating kind so the metrics layer can isolate OCC contention", () => {
        expect.assertions(2);

        // Only `occ` is true write contention; a unique-index breach is a
        // constraint failure that must not trip the write-contention advisor.
        expect(new ConflictError("optimistic concurrency conflict", "occ").kind).toBe("occ");
        expect(new ConflictError("unique constraint violation", "unique").kind).toBe("unique");
    });
});

describe("shardDO.errorToResponse — ConflictError", () => {
    it("maps a thrown ConflictError to a 409 with code CONFLICT", async () => {
        expect.assertions(3);

        const shard = new TestShardDO(createFakeState());
        const response = await shard.errorResponse(new ConflictError("version mismatch"));

        expect(response.status).toBe(409);

        const body = await response.json<{ error: { code: string; message: string } }>();

        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe("version mismatch");
    });
});
