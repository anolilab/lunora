import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import type { AuthJurisdictionMove, ExecutionContextLike } from "../src/create-worker";
import { COPY_AUTH_TO_JURISDICTION_OP, createWorker, PURGE_UNPINNED_AUTH_OP } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

// The auth objects are not shards: a correct implementation never forwards these ops.
const failingShard: ShardNamespaceLike = {
    get: () => {
        return {
            fetch: async () => {
                throw new Error("the auth move must not reach a shard");
            },
        };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "move-admin";

const REPORT = { done: true, tables: [{ conflicts: 0, copied: 3, deleted: 0, sourceRows: 3, table: "user", targetRows: 3, unchanged: 0, updated: 0 }] };

const moveSpy = (): AuthJurisdictionMove => {
    return {
        copy: vi.fn<AuthJurisdictionMove["copy"]>(async () => REPORT),
        purge: vi.fn<AuthJurisdictionMove["purge"]>(async () => {
            return { dropped: ["user"] };
        }),
    };
};

const rpc = (functionPath: string, args: Record<string, unknown> = {}, admin = true): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers: admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {},
        method: "POST",
    });

describe("createWorker — auth jurisdiction move admin RPCs", () => {
    it.each([COPY_AUTH_TO_JURISDICTION_OP, PURGE_UNPINNED_AUTH_OP])("rejects a non-admin caller of %s before touching the move", async (op) => {
        expect.assertions(4);

        const move = moveSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authJurisdictionMove: move, shardDO: failingShard });
        const response = await worker.fetch(rpc(op, {}, false), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(403);
        expect(body.error.code).toBe("ADMIN_FORBIDDEN");
        expect(move.copy).not.toHaveBeenCalled();
        expect(move.purge).not.toHaveBeenCalled();
    });

    it("reports AUTH_MOVE_NOT_CONFIGURED when auth is not pinned", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: failingShard });
        const response = await worker.fetch(rpc(COPY_AUTH_TO_JURISDICTION_OP), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("AUTH_MOVE_NOT_CONFIGURED");
    });

    it("copies with the caller's force flag and answers the per-table report", async () => {
        expect.assertions(3);

        const move = moveSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authJurisdictionMove: move, shardDO: failingShard });
        const response = await worker.fetch(rpc(COPY_AUTH_TO_JURISDICTION_OP, { force: true }), {}, fakeContext);
        const body: { result: unknown } = await response.json();

        expect(response.status).toBe(200);
        expect(move.copy).toHaveBeenCalledWith({ force: true });
        expect(decodeWire(body.result)).toStrictEqual(REPORT);
    });

    it("does not treat a truthy non-boolean as force", async () => {
        expect.assertions(1);

        const move = moveSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authJurisdictionMove: move, shardDO: failingShard });

        await worker.fetch(rpc(COPY_AUTH_TO_JURISDICTION_OP, { force: "yes" }), {}, fakeContext);

        expect(move.copy).toHaveBeenCalledWith({ force: false });
    });

    it("surfaces the move's refusal with its code and status", async () => {
        expect.assertions(2);

        const move = moveSpy();

        vi.mocked(move.copy).mockRejectedValueOnce(new LunoraError("AUTH_MOVE_TARGET_NOT_EMPTY", "the pinned auth object already has 1 user(s)"));

        const worker = createWorker({ adminToken: ADMIN_TOKEN, authJurisdictionMove: move, shardDO: failingShard });
        const response = await worker.fetch(rpc(COPY_AUTH_TO_JURISDICTION_OP), {}, fakeContext);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(409);
        expect(body.error.code).toBe("AUTH_MOVE_TARGET_NOT_EMPTY");
    });

    it("purges through the move", async () => {
        expect.assertions(2);

        const move = moveSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authJurisdictionMove: move, shardDO: failingShard });
        const response = await worker.fetch(rpc(PURGE_UNPINNED_AUTH_OP), {}, fakeContext);
        const body: { result: unknown } = await response.json();

        expect(move.purge).toHaveBeenCalledTimes(1);
        expect(decodeWire(body.result)).toStrictEqual({ dropped: ["user"] });
    });
});
