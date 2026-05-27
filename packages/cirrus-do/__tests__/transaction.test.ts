import { beforeEach, describe, expect, test, vi } from "vitest";

import { ShardDO, type ShardDOState } from "../src/ShardDO.js";
import { ConflictError } from "../src/transaction.js";

interface FakeSql {
    exec: ReturnType<typeof vi.fn>;
}

interface FakeState extends ShardDOState {
    sockets: never[];
    storage: { sql: FakeSql };
}

const createFakeState = (sqlExec: ReturnType<typeof vi.fn> = vi.fn()): FakeState => {
    const state: FakeState = {
        sockets: [],
        storage: { sql: { exec: sqlExec } },
        id: { name: "test-shard" },
        acceptWebSocket: vi.fn(),
        getWebSockets: vi.fn(() => []),
    };

    return state;
};

class TestShardDO extends ShardDO {
    public constructor(state: ShardDOState) {
        super(state, {});
    }

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
                method: "POST",
                body: JSON.stringify({ functionPath: "noop" }),
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
    let exec: ReturnType<typeof vi.fn>;
    let shard: TestShardDO;

    beforeEach(() => {
        exec = vi.fn();
        shard = new TestShardDO(createFakeState(exec));
    });

    test("wraps handler in BEGIN / COMMIT on success", async () => {
        const result = await shard.callRunInTransaction(() => 42);

        expect(result).toBe(42);
        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT"]);
    });

    test("emits ROLLBACK when the handler throws", async () => {
        const boom = new Error("boom");

        await expect(
            shard.callRunInTransaction(() => {
                throw boom;
            }),
        ).rejects.toBe(boom);

        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    });

    test("re-throws ConflictError after rolling back", async () => {
        const conflict = new ConflictError("stale version");

        await expect(
            shard.callRunInTransaction(() => {
                throw conflict;
            }),
        ).rejects.toBe(conflict);

        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    });

    test("refuses nested transactions with NESTED_TRANSACTION code", async () => {
        await expect(
            shard.callRunInTransaction(async () => {
                await shard.callRunInTransaction(() => 1);
            }),
        ).rejects.toMatchObject({ code: "NESTED_TRANSACTION", status: 500, name: "CirrusError" });
    });

    test("swallows secondary ROLLBACK errors so the original throw propagates", async () => {
        let firstCall = true;

        exec.mockImplementation((query: string) => {
            if (query === "ROLLBACK") {
                throw new Error("rollback failed");
            }

            if (query === "BEGIN") {
                firstCall = false;
            }

            void firstCall;
        });

        const original = new Error("handler failure");

        await expect(
            shard.callRunInTransaction(() => {
                throw original;
            }),
        ).rejects.toBe(original);
    });

    test("clears transactionDepth in the finally branch so a second tx can run", async () => {
        await shard.callRunInTransaction(() => 1);
        await shard.callRunInTransaction(() => 2);

        const queries = exec.mock.calls.map((call) => call[0]);

        expect(queries).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    });

    test("conflictError carries code / status / name as own properties", () => {
        const error = new ConflictError();

        expect(error.code).toBe("CONFLICT");
        expect(error.status).toBe(409);
        expect(error.name).toBe("ConflictError");
        expect(error.message).toBe("Optimistic concurrency conflict");
    });
});

describe("shardDO.errorToResponse — ConflictError", () => {
    test("maps a thrown ConflictError to a 409 with code CONFLICT", async () => {
        const shard = new TestShardDO(createFakeState());
        const response = await shard.errorResponse(new ConflictError("version mismatch"));

        expect(response.status).toBe(409);

        const body = (await response.json()) as { error: { code: string; message: string } };

        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe("version mismatch");
    });
});
