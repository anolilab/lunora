import { describe, expect, it } from "vitest";

import { defineModule } from "../src/module";

describe("defineModule", () => {
    it("brands the config", () => {
        expect.assertions(1);

        expect(defineModule({ description: "Billing", tables: ["invoices"] })).toStrictEqual({
            description: "Billing",
            isLunoraModule: true,
            tables: ["invoices"],
        });
    });

    it("accepts no config", () => {
        expect.assertions(1);

        expect(defineModule()).toStrictEqual({ isLunoraModule: true });
    });

    it("rejects a non-string description and a malformed table list", () => {
        expect.assertions(3);

        expect(() => defineModule({ description: 1 as never })).toThrow(/description/u);
        expect(() => defineModule({ tables: "invoices" as never })).toThrow(/tables/u);
        expect(() => defineModule({ tables: [""] })).toThrow(/tables/u);
    });
});
