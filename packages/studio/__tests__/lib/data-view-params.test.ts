import { describe, expect, it } from "vitest";

import { dataViewToSearch, searchToDataView } from "../../src/lib/data-view-params";
import type { DataView } from "../../src/lib/saved-queries";

describe("dataViewParams", () => {
    it("hydrates the default shard view from empty params", () => {
        expect.assertions(1);

        expect(searchToDataView({})).toEqual({
            filters: undefined,
            orderBy: undefined,
            search: undefined,
            shard: undefined,
            table: undefined,
            tier: "shard",
        });
    });

    it("serializes the default view to an empty patch", () => {
        expect.assertions(1);

        expect(dataViewToSearch({ tier: "shard" })).toEqual({
            filters: undefined,
            order: undefined,
            schema: undefined,
            search: undefined,
            shard: undefined,
            table: undefined,
        });
    });

    it("round-trips a full view through serialize -> URL -> hydrate", () => {
        expect.assertions(1);

        const view: DataView = {
            filters: [
                { column: "status", operator: "eq", value: "error" },
                { column: "name", operator: "contains", value: "boom" },
            ],
            orderBy: { column: "createdAt", direction: "desc" },
            search: "needle",
            shard: "room-1",
            table: "messages",
            tier: "global",
        };

        const search = dataViewToSearch(view);

        // What the router carries: undefined params are dropped, the rest are strings.
        const carried: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(search)) {
            if (value !== undefined) {
                carried[key] = value;
            }
        }

        expect(searchToDataView(carried)).toEqual(view);
    });

    it("preserves a colon in the ordered column name", () => {
        expect.assertions(1);

        const search = dataViewToSearch({ orderBy: { column: "ns:col", direction: "asc" }, tier: "shard" });

        expect(searchToDataView({ order: search["order"] }).orderBy).toEqual({ column: "ns:col", direction: "asc" });
    });

    it("drops a malformed order param", () => {
        expect.assertions(2);

        expect(searchToDataView({ order: "createdAt" }).orderBy).toBeUndefined();
        expect(searchToDataView({ order: "createdAt:sideways" }).orderBy).toBeUndefined();
    });

    it("drops malformed filters, keeping the valid ones", () => {
        expect.assertions(1);

        const filters = JSON.stringify([
            { column: "status", operator: "eq", value: "error" },
            { column: "bad", operator: "nope" },
            { operator: "eq" },
            "garbage",
        ]);

        expect(searchToDataView({ filters }).filters).toEqual([{ column: "status", operator: "eq", value: "error" }]);
    });

    it("tolerates non-JSON filters", () => {
        expect.assertions(1);

        expect(searchToDataView({ filters: "{not json" }).filters).toBeUndefined();
    });
});
