import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import type { AdvisorInsertWrite } from "../src";
import { fromServerSchema } from "../src";
import tableWithoutInsert from "../src/lints/static/table-without-insert";

const schema = () =>
    fromServerSchema(
        defineSchema({
            channels: defineTable({ name: v.string() }),
            messages: defineTable({ text: v.string() }),
        }),
    );

const run = (inserts?: AdvisorInsertWrite[]) => tableWithoutInsert.run({ inserts, schema: schema() });

describe("table_without_insert", () => {
    it("finds nothing when no write evidence is supplied", () => {
        expect.assertions(1);

        // A runtime caller (no insert feeder) must not flag every table.
        expect(run()).toHaveLength(0);
    });

    it("flags every table when the feeder ran but found no inserts", () => {
        expect.assertions(1);

        expect(run([]).map((finding) => finding.metadata.table)).toStrictEqual(["channels", "messages"]);
    });

    it("flags only the tables with no discovered insert", () => {
        expect.assertions(2);

        const inserts: AdvisorInsertWrite[] = [{ exportName: "send", file: "messages", line: 1, table: "messages" }];
        const findings = run(inserts);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "table_without_insert:channels",
            categories: ["SCHEMA"],
            level: "INFO",
            metadata: { table: "channels" },
            name: "table_without_insert",
        });
    });

    it("ignores inserts whose table argument wasn't a string literal", () => {
        expect.assertions(1);

        const inserts: AdvisorInsertWrite[] = [{ exportName: "dynamic", file: "f", line: 1, table: "" }];

        expect(run(inserts)).toHaveLength(2);
    });
});
