/**
 * PROTOTYPE coverage (plan 247, design spike) — proves `defineEventStore` can
 * type ONE schema into both a Pipelines `send()` and an r2sql `query()` over
 * the same table, and — the load-bearing claim — that an off-schema `send()`
 * is caught at runtime, not merely disallowed by TypeScript.
 *
 * Doubles mirror the package's existing per-binding tests:
 * `PipelineBindingLike` as a plain object (see
 * `__tests__/pipelines/create-pipelines.test.ts`), and a real `createR2Sql`
 * client wired to a fake `fetch` (see `__tests__/r2sql/client.test.ts`) so
 * `query().run()` exercises the real `SelectBuilder` + envelope-parsing path,
 * not a hand-rolled stand-in.
 */
import { describe, expect, it, vi } from "vitest";

import { defineEventStore } from "../../src/event-store/define-event-store";
import type { EventStoreRecord, EventStoreSchema } from "../../src/event-store/types";
import { createR2Sql } from "../../src/r2sql/client";

const schema = {
    amount: "number",
    id: "string",
    occurredAt: "timestamp",
} as const satisfies EventStoreSchema;

type PurchaseEvent = EventStoreRecord<typeof schema>;

interface FakeResponseInit {
    body?: unknown;
    ok?: boolean;
    status?: number;
}

const fakeResponse = (init: FakeResponseInit = {}): Response => {
    const { body = { result: { rows: [], schema: [] }, success: true }, ok = true, status = 200 } = init;

    return {
        json: async () => body,
        ok,
        status,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
};

const setup = (responseInit?: FakeResponseInit) => {
    const send = vi.fn<(records: unknown[]) => Promise<void>>(async () => {});
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(responseInit));
    const r2sql = createR2Sql({ accountId: "acc", apiToken: "secret", bucket: "events", fetch: fetchImpl });

    const store = defineEventStore({
        pipeline: { send },
        r2sql,
        schema,
        table: "analytics.purchases",
    });

    return { fetchImpl, send, store };
};

describe("defineEventStore (prototype)", () => {
    it("types one schema into a working send() over the Pipelines binding-like", async () => {
        expect.assertions(1);

        const { send, store } = setup();
        const event: PurchaseEvent = { amount: 42, id: "evt-1", occurredAt: "2026-07-31T00:00:00Z" };

        await store.send(event);

        expect(send).toHaveBeenCalledWith([event]);
    });

    it("types the same schema into a query() built from the real r2sql SelectBuilder over the same table", async () => {
        expect.assertions(2);

        const { fetchImpl, store } = setup({ body: { result: { rows: [{ amount: 42, id: "evt-1", occurredAt: "2026-07-31T00:00:00Z" }] }, success: true } });

        const result = await store.query().where("amount > 10").orderBy("occurredAt").limit(5).run();

        const sentQuery = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).query as string;

        // The query executed against the SAME `table` passed to `defineEventStore`
        // — the whole point being that write and read target one physical table
        // under one declared schema, not two independently maintained references.
        expect(sentQuery).toBe("SELECT * FROM analytics.purchases WHERE amount > 10 ORDER BY occurredAt LIMIT 5");
        expect(result.rows).toEqual([{ amount: 42, id: "evt-1", occurredAt: "2026-07-31T00:00:00Z" }]);
    });

    it("catches a wrong-typed field at send() time, at runtime — not just a compile-time cast", async () => {
        expect.assertions(2);

        const { send, store } = setup();
        // A plain-JS caller (or a stale build, or an `as` cast) can hand send() a
        // record TypeScript would otherwise reject — `amount` is a string, not
        // the schema's declared `number`. This is the case the design doc calls
        // out: EventStoreRecord<Schema> alone is compile-time-only.
        const offSchema = { amount: "forty-two", id: "evt-2", occurredAt: "2026-07-31T00:00:00Z" } as unknown as PurchaseEvent;

        await expect(store.send(offSchema)).rejects.toThrow(/"amount" must be a number/);
        expect(send).not.toHaveBeenCalled();
    });

    it("catches a missing declared field at send() time", async () => {
        expect.assertions(1);

        const { store } = setup();
        const missingField = { id: "evt-3", occurredAt: "2026-07-31T00:00:00Z" } as unknown as PurchaseEvent;

        await expect(store.send(missingField)).rejects.toThrow(/"amount" must be a number/);
    });

    it("catches a field the schema does not declare (the table's columns are fixed)", async () => {
        expect.assertions(1);

        const { store } = setup();
        const extraField = { amount: 1, id: "evt-4", occurredAt: "2026-07-31T00:00:00Z", unexpected: "nope" } as unknown as PurchaseEvent;

        await expect(store.send(extraField)).rejects.toThrow(/"unexpected" is not declared in the schema/);
    });
});
