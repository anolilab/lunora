import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupDatabases, permit, setup, TestShard } from "./_helpers/delivery-authorization";

const request = (mutationId: string) =>
    new Request("https://shard.internal/rpc", {
        method: "POST",
        headers: { "x-lunora-userid": "alice", "x-lunora-mutation-id": mutationId },
        body: JSON.stringify({ functionPath: "messages:act", args: {} }),
    });

class RetentionShard extends TestShard {
    public result: unknown = "old-policy";
    public forceCacheMiss = false;

    public override handleRpc(): Promise<unknown> {
        this.rpcRuns += 1;

        return Promise.resolve(this.result);
    }

    public override readIdempotentResult(mutationId: string | undefined): { value: unknown } | undefined {
        return this.forceCacheMiss ? undefined : super.readIdempotentResult(mutationId);
    }
}

describe("delivery receipt retention", () => {
    afterEach(cleanupDatabases);

    it("keeps the old result fenced when receipt cleanup fails before key reuse", async () => {
        expect.hasAssertions();

        const test = setup();
        const shard = new RetentionShard(test.state, {}, { deliveryAuthorization: test.authority });
        let now = 100_000_000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const original = await shard.fetch(request("reused"));

            expect(original.status).toBe(200);

            test.database.sql.exec(
                "CREATE TRIGGER reject_receipt_trim BEFORE DELETE ON __lunora_delivery_receipt BEGIN SELECT RAISE(FAIL, 'receipt trim unavailable'); END",
            );

            now += 2 * 86_400_000;

            test.regrant();

            shard.result = "maintenance";

            const maintenance = await shard.fetch(request("maintenance"));

            expect(maintenance.status).toBe(200);

            test.database.sql.exec("DROP TRIGGER reject_receipt_trim");

            shard.result = "new-policy";

            const reused = await shard.fetch(request("reused"));

            // Failed cleanup must leave the old result paired with its old marker.
            // A different epoch stays fenced instead of executing and inheriting it.
            expect(reused.status).toBe(409);
            await expect(reused.json()).resolves.toMatchObject({ error: { code: "DELIVERY_RECEIPT_FENCED" } });
            expect(shard.rpcRuns).toBe(2);
            expect(test.database.raw("SELECT result_json FROM __idempotency WHERE mutation_id = 'reused'")).toEqual([{ result_json: '"old-policy"' }]);
            expect(test.database.raw("SELECT scope, epoch FROM __lunora_delivery_receipt WHERE mutation_id = 'reused'")).toEqual([permit(0)]);
        } finally {
            clock.mockRestore();
        }
    });

    it("does not recertify an existing same-byte row after its marker was trimmed", async () => {
        expect.hasAssertions();

        const test = setup();
        const shard = new RetentionShard(test.state, {}, { deliveryAuthorization: test.authority });
        let now = 100_000_000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const original = await shard.fetch(request("reused"));

            expect(original.status).toBe(200);

            test.database.sql.exec("CREATE TRIGGER reject_result_trim BEFORE DELETE ON __idempotency BEGIN SELECT RAISE(FAIL, 'result trim unavailable'); END");

            now += 2 * 86_400_000;

            test.regrant();

            shard.result = "maintenance";

            const maintenance = await shard.fetch(request("maintenance"));

            expect(maintenance.status).toBe(200);

            // Model a completed receipt delete followed by a failed native-row delete.
            // On the fixed path the retention sweep already did this; on the old order,
            // this creates the same fail-closed partial state for the regression.
            test.database.sql.exec("DELETE FROM __lunora_delivery_receipt WHERE identity = 'alice' AND mutation_id = 'reused'");

            shard.result = "old-policy";
            shard.forceCacheMiss = true;

            const staleClaim = await shard.fetch(request("reused"));

            expect(staleClaim.status).toBe(200);

            shard.forceCacheMiss = false;

            const replay = await shard.fetch(request("reused"));

            expect(replay.status).toBe(409);
            await expect(replay.json()).resolves.toMatchObject({ error: { code: "DELIVERY_RECEIPT_FENCED" } });
            expect(test.database.raw("SELECT scope, epoch FROM __lunora_delivery_receipt WHERE mutation_id = 'reused'")).toEqual([]);
        } finally {
            clock.mockRestore();
        }
    });

    it("replaces an orphaned receipt when key reuse inserts a genuinely new result", async () => {
        expect.hasAssertions();

        const test = setup();
        const shard = new RetentionShard(test.state, {}, { deliveryAuthorization: test.authority });
        const now = 100_000_000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            const original = await shard.fetch(request("reused"));

            expect(original.status).toBe(200);

            // Reproduce the old result-first sweep's partial state: the expired
            // native result is gone, while a failed receipt delete left its marker.
            test.database.sql.exec("DELETE FROM __idempotency WHERE identity = 'alice' AND mutation_id = 'reused'");

            test.regrant();

            shard.result = "new-policy";

            const replacement = await shard.fetch(request("reused"));
            const replacementBody = await replacement.json();

            expect(replacement.status).toBe(200);
            expect(test.database.raw("SELECT scope, epoch FROM __lunora_delivery_receipt WHERE mutation_id = 'reused'")).toEqual([permit(1)]);

            const replay = await shard.fetch(request("reused"));

            expect(replay.status).toBe(200);
            await expect(replay.json()).resolves.toEqual(replacementBody);
            expect(replacementBody).toMatchObject({ result: "new-policy" });
            expect(shard.rpcRuns).toBe(2);
        } finally {
            clock.mockRestore();
        }
    });
});
