import { describe, expect, it } from "vitest";

import { dataViewToSearch, searchToDataView, validateDataViewSearch, validateSchemaVersionSearch } from "../../src/lib/data-view-params";
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

/**
 * The router boundary. Everything downstream reads `useSearch` as trustworthy,
 * so anything hand-edited, legacy, or hostile has to be dropped here rather than
 * defended against in every reader.
 */
describe("validateDataViewSearch", () => {
    it("drops every unknown param", () => {
        expect.assertions(1);

        expect(validateDataViewSearch({ __proto__: "x", evil: "<script>", token: "secret" })).toStrictEqual({});
    });

    it("passes valid values through verbatim so shared links stay compatible", () => {
        expect.assertions(1);

        const filters = JSON.stringify([{ column: "status", operator: "eq", value: "error" }]);

        expect(
            validateDataViewSearch({ filters, order: "createdAt:desc", pins: "id,name", schema: "global", search: "boom", shard: "room-1", table: "logs" }),
        ).toStrictEqual({ filters, order: "createdAt:desc", pins: "id,name", schema: "global", search: "boom", shard: "room-1", table: "logs" });
    });

    it("keeps only the `global` schema tier and drops any other value", () => {
        expect.assertions(3);

        expect(validateDataViewSearch({ schema: "global" }).schema).toBe("global");
        expect(validateDataViewSearch({ schema: "shard" }).schema).toBeUndefined();
        expect(validateDataViewSearch({ schema: "GLOBAL" }).schema).toBeUndefined();
    });

    it("rejects blank and whitespace-only strings rather than passing them downstream", () => {
        expect.assertions(1);

        expect(validateDataViewSearch({ search: "", shard: "   ", table: "  " })).toStrictEqual({});
    });

    it("trims a padded value instead of treating the padding as part of the name", () => {
        expect.assertions(1);

        expect(validateDataViewSearch({ table: "  logs  " }).table).toBe("logs");
    });

    it("ignores non-string params of the right name", () => {
        expect.assertions(1);

        expect(validateDataViewSearch({ filters: 1, order: {}, pins: [], search: true, shard: null, table: 0 })).toStrictEqual({});
    });

    it("keeps `order` only when it matches the column:asc|desc grammar", () => {
        expect.assertions(6);

        expect(validateDataViewSearch({ order: "createdAt:asc" }).order).toBe("createdAt:asc");
        // A colon in the column name is fine — the direction is split off the LAST one.
        expect(validateDataViewSearch({ order: "a:b:desc" }).order).toBe("a:b:desc");
        expect(validateDataViewSearch({ order: "createdAt:sideways" }).order).toBeUndefined();
        expect(validateDataViewSearch({ order: "createdAt" }).order).toBeUndefined();
        // No column before the separator.
        expect(validateDataViewSearch({ order: ":asc" }).order).toBeUndefined();
        expect(validateDataViewSearch({ order: "createdAt:ASC" }).order).toBeUndefined();
    });

    it("keeps `filters` only when the JSON parses into at least one valid clause", () => {
        expect.assertions(4);

        const good = JSON.stringify([{ column: "a", operator: "gte", value: 1 }]);

        expect(validateDataViewSearch({ filters: good }).filters).toBe(good);
        expect(validateDataViewSearch({ filters: "{not json" }).filters).toBeUndefined();
        expect(validateDataViewSearch({ filters: "[]" }).filters).toBeUndefined();
        // An unknown operator is not a clause, so nothing valid survives the filter.
        expect(validateDataViewSearch({ filters: JSON.stringify([{ column: "a", operator: "DROP" }]) }).filters).toBeUndefined();
    });

    it("caps `pins` so a hand-edited link cannot push unbounded state into storage", () => {
        expect.assertions(3);

        // At most 12 names…
        expect(validateDataViewSearch({ pins: Array.from({ length: 20 }, (_, index) => `c${String(index)}`).join(",") }).pins?.split(",")).toHaveLength(12);
        // …each at most 64 chars (the over-long one is dropped, the others kept)…
        expect(validateDataViewSearch({ pins: `${"x".repeat(65)},ok` }).pins).toBe("ok");
        // …and empty segments never become a pin.
        expect(validateDataViewSearch({ pins: ",,," }).pins).toBeUndefined();
    });
});

describe("validateSchemaVersionSearch", () => {
    it("accepts a 16-char lowercase-hex snapshot hash", () => {
        expect.assertions(1);

        expect(validateSchemaVersionSearch({ version: "deadbeefdeadbeef" })).toStrictEqual({ version: "deadbeefdeadbeef" });
    });

    // The value is forwarded to an RPC, so an implausible hash is dropped here
    // rather than passed through.
    it("drops anything that is not a plausible content hash", () => {
        expect.assertions(6);

        expect(validateSchemaVersionSearch({ version: "DEADBEEFDEADBEEF" })).toStrictEqual({});
        expect(validateSchemaVersionSearch({ version: "deadbeefdeadbee" })).toStrictEqual({});
        expect(validateSchemaVersionSearch({ version: "deadbeefdeadbeef0" })).toStrictEqual({});
        expect(validateSchemaVersionSearch({ version: "deadbeefdeadbeeg" })).toStrictEqual({});
        expect(validateSchemaVersionSearch({ version: 1 })).toStrictEqual({});
        expect(validateSchemaVersionSearch({})).toStrictEqual({});
    });

    it("drops every other param", () => {
        expect.assertions(1);

        expect(validateSchemaVersionSearch({ table: "logs", version: "deadbeefdeadbeef" })).toStrictEqual({ version: "deadbeefdeadbeef" });
    });
});
