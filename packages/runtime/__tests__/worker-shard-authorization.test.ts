import { describe, expect, it, vi } from "vitest";

import { LunoraError } from "../src/errors";
import type { WorkerRuntimeContext } from "../src/worker/context";
import { assertShardAuthorized, authorizeRpcEnvelope } from "../src/worker/shard-authorization";

const buildContext = (overrides: Partial<WorkerRuntimeContext> = {}): WorkerRuntimeContext => {
    return {
        assertAgentRunOnDefaultShard: () => undefined,
        defaultShard: "__root__",
        guardUnauthenticatedShardAccess: (kind) => {
            throw new LunoraError(`${kind} access is default-denied`, { code: kind === "fan-out" ? "FORBIDDEN_FANOUT" : "FORBIDDEN_SHARD", status: 403 });
        },
        ...overrides,
    };
};

describe("shard authorization (direct, hand-built context)", () => {
    it("denies a verdict that is truthy but not exactly true", async () => {
        expect.assertions(1);

        const context = buildContext({ authorizeShard: () => ({ valid: false }) as unknown as boolean });

        await expect(assertShardAuthorized(context, null, "tenant-a")).rejects.toMatchObject({ code: "FORBIDDEN_SHARD", status: 403 });
    });

    it("refuses a reserved relay shard key even for an admin request", async () => {
        expect.assertions(1);

        await expect(assertShardAuthorized(buildContext(), null, "tenant::relay::0", true)).rejects.toMatchObject({ code: "FORBIDDEN_SHARD" });
    });

    it("default-denies a non-default shard when no callback is configured, but allows the default shard", async () => {
        expect.assertions(2);

        const guard = vi.fn<WorkerRuntimeContext["guardUnauthenticatedShardAccess"]>(() => {
            throw new LunoraError("denied", { code: "FORBIDDEN_SHARD", status: 403 });
        });
        const context = buildContext({ guardUnauthenticatedShardAccess: guard });

        await expect(assertShardAuthorized(context, null, "tenant-a")).rejects.toMatchObject({ code: "FORBIDDEN_SHARD" });
        await expect(assertShardAuthorized(context, null, "__root__")).resolves.toBeUndefined();
    });

    it("default-denies a fan-out when only authorizeShard is configured", async () => {
        expect.assertions(1);

        const context = buildContext({ authorizeShard: () => true });

        await expect(authorizeRpcEnvelope(context, { fanOut: { table: "messages" }, functionPath: "messages:list" }, null)).rejects.toMatchObject({
            code: "FORBIDDEN_FANOUT",
        });
    });

    it("exempts a single-shard reserved admin RPC from the tenant gate", async () => {
        expect.assertions(2);

        const authorizeShard = vi.fn<NonNullable<WorkerRuntimeContext["authorizeShard"]>>(() => false);
        const context = buildContext({ authorizeShard });

        await expect(authorizeRpcEnvelope(context, { functionPath: "__lunora_admin__:ping", shardKey: "tenant-a" }, null)).resolves.toBeUndefined();
        expect(authorizeShard).not.toHaveBeenCalled();
    });
});
