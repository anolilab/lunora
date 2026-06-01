import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";
import { ConflictError } from "../src/transaction.js";

type ExecMock = ((query: string) => unknown) & {
    mock: { calls: unknown[][] };
    mockImplementation: (impl: (query: string) => unknown) => ExecMock;
};

interface FakeState extends ShardDOState {
    sockets: never[];
    storage: { sql: { exec: ExecMock } };
}

const createFakeState = (sqlExec: ExecMock = vi.fn<(query: string) => unknown>()): FakeState => {
    const state: FakeState = {
        acceptWebSocket: vi.fn<ShardDOState["acceptWebSocket"]>(),
        getWebSockets: vi.fn<ShardDOState["getWebSockets"]>(() => []),
        id: { name: "test-shard" },
        sockets: [],
        storage: { sql: { exec: sqlExec } },
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
    let shard: TestShardDO;

    beforeEach(() => {
        exec = vi.fn<(query: string) => unknown>();
        shard = new TestShardDO(createFakeState(exec));
    });

    it("wraps handler in BEGIN / COMMIT on success", async () => {
        expect.assertions(2);

        const result = await shard.callRunInTransaction(() => 42);

        expect(result).toBe(42);
        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT"]);
    });

    it("emits ROLLBACK when the handler throws", async () => {
        expect.assertions(2);

        const boom = new Error("boom");

        await expect(
            shard.callRunInTransaction(() => {
                throw boom;
            }),
        ).rejects.toBe(boom);

        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    });

    it("re-throws ConflictError after rolling back", async () => {
        expect.assertions(2);

        const conflict = new ConflictError("stale version");

        await expect(
            shard.callRunInTransaction(() => {
                throw conflict;
            }),
        ).rejects.toBe(conflict);

        expect(exec.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "ROLLBACK"]);
    });

    it("refuses nested transactions with NESTED_TRANSACTION code", async () => {
        expect.assertions(1);

        await expect(
            shard.callRunInTransaction(async () => {
                await shard.callRunInTransaction(() => 1);
            }),
        ).rejects.toMatchObject({ code: "NESTED_TRANSACTION", name: "CirrusError", status: 500 });
    });

    it("swallows secondary ROLLBACK errors so the original throw propagates", async () => {
        expect.assertions(1);

        exec.mockImplementation((query: string) => {
            if (query === "ROLLBACK") {
                throw new Error("rollback failed");
            }
        });

        const original = new Error("handler failure");

        await expect(
            shard.callRunInTransaction(() => {
                throw original;
            }),
        ).rejects.toBe(original);
    });

    it("clears transactionDepth in the finally branch so a second tx can run", async () => {
        expect.assertions(1);

        await shard.callRunInTransaction(() => 1);
        await shard.callRunInTransaction(() => 2);

        const queries = exec.mock.calls.map((call) => call[0]);

        expect(queries).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    });

    it("conflictError carries code / status / name as own properties", () => {
        expect.assertions(4);

        const error = new ConflictError();

        expect(error.code).toBe("CONFLICT");
        expect(error.status).toBe(409);
        expect(error.name).toBe("ConflictError");
        expect(error.message).toBe("Optimistic concurrency conflict");
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
