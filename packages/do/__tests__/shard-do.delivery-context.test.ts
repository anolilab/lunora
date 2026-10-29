import { LunoraError } from "@lunora/errors";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";
import { afterEach, describe, expect, it } from "vitest";

import { createShardClient } from "../../runtime/src/shard-client";
import { cleanupDatabases, permit, setup, TestShard } from "./_helpers/delivery-authorization";

class ContextShard extends TestShard {
    public override handleRpc(): Promise<unknown> {
        this.rpcRuns += 1;
        if (!this.isSystemDispatch()) {
            throw new LunoraError("FUNCTION_NOT_FOUND");
        }
        return Promise.resolve({ system: this.isSystemDispatch() });
    }

    public broadcast(): void {
        this.broadcastDelta({ table: "messages", op: "insert", key: "one", row: { _id: "one" } });
    }
}

const rpc = (functionPath: string, headers: Record<string, string> = {}) =>
    new Request("https://shard.internal/rpc", { method: "POST", headers, body: JSON.stringify({ functionPath, args: {} }) });

describe("delivery authority caller context", () => {
    afterEach(cleanupDatabases);

    it("passes a real internal shard client's system privilege without granting ordinary callers", async () => {
        expect.hasAssertions();

        const test = setup("folder");
        const shard = new ContextShard(test.state, {}, { deliveryAuthorization: test.authority });
        const namespace = {
            idFromName: (name: string) => name,
            get: () => {
                return { fetch: (request: Request) => shard.fetch(request) };
            },
        };

        test.authority.mockImplementation(async ({ system }) => (system ? permit(0) : undefined));

        const client = createShardClient(namespace).as({ userId: "alice" }).asSystem().forShard("folder");

        await expect(client.call("internal:recover", {})).resolves.toEqual({ system: true });
        expect(test.authority.mock.calls[0]?.[0]).toMatchObject({ admin: false, system: true, transport: "rpc", identity: { userId: undefined } });

        const denied = await shard.fetch(rpc("internal:recover"));

        expect(denied.status).toBe(403);
        expect(shard.rpcRuns).toBe(1);
        expect(test.authority.mock.calls[1]?.[0]).toMatchObject({ admin: false, system: false });

        test.authority.mockResolvedValue(undefined);

        await expect(client.call("internal:recover", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(shard.rpcRuns).toBe(1);
    });

    it("sets admin only for a validated bearer on an admin operation and retains the native admin gate", async () => {
        expect.hasAssertions();

        const test = setup();
        const adminToken = "test-admin";
        const shard = new ContextShard(test.state, { LUNORA_ADMIN_TOKEN: adminToken }, { deliveryAuthorization: test.authority });

        test.authority.mockImplementation(async ({ admin }) => (admin ? permit(0) : undefined));

        const valid = await shard.fetch(rpc(ADMIN_FUNCTIONS.listTables, { authorization: `Bearer ${adminToken}` }));

        expect(valid.status).toBe(200);
        expect(test.authority.mock.calls[0]?.[0]).toMatchObject({ admin: true, system: false });

        const invalid = await shard.fetch(rpc(ADMIN_FUNCTIONS.listTables, { authorization: "Bearer wrong" }));

        expect(invalid.status).toBe(403);
        expect(test.authority.mock.calls[1]?.[0]).toMatchObject({ admin: false, system: false });

        const ordinary = await shard.fetch(rpc("messages:list", { authorization: `Bearer ${adminToken}` }));

        expect(ordinary.status).toBe(403);
        expect(test.authority.mock.calls[2]?.[0]).toMatchObject({ admin: false, system: false });

        test.authority.mockResolvedValue(permit(0));

        const stillInvalid = await shard.fetch(rpc(ADMIN_FUNCTIONS.listTables, { authorization: "Bearer wrong" }));

        expect(stillInvalid.status).toBe(403);
        await expect(stillInvalid.json()).resolves.toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });
        expect(shard.rpcRuns).toBe(0);

        test.authority.mockResolvedValue(undefined);

        const authorityDenied = await shard.fetch(rpc(ADMIN_FUNCTIONS.listTables, { authorization: `Bearer ${adminToken}` }));

        expect(authorityDenied.status).toBe(403);
    });

    it("never treats a subscription as a trusted system or admin RPC", async () => {
        expect.hasAssertions();

        const test = setup();

        test.socket.attachment.admin = true;

        await test.send();

        expect(test.authority.mock.calls[0]?.[0]).toMatchObject({ admin: false, system: false, transport: "subscription" });
    });

    it("explicitly refuses guarded broadcasts and preserves the unguarded API", () => {
        expect.hasAssertions();

        const test = setup();
        const guarded = new ContextShard(test.state, {}, { deliveryAuthorization: test.authority });
        const unguarded = new ContextShard(test.state, {});

        test.socket.attachment.subs.view = { table: "messages" };

        expect(() => {
            guarded.broadcast();
        }).toThrow(expect.objectContaining({ code: "NOT_IMPLEMENTED" }));
        expect(test.socket.frames).toEqual([]);

        unguarded.broadcast();

        expect(test.socket.frames).toEqual([{ type: "delta", id: "view", delta: { table: "messages", op: "insert", key: "one", row: { _id: "one" } } }]);
    });
});
