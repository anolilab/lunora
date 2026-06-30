import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorShape } from "../src";
import { fromServerSchema } from "../src";
import shapeTargetsGlobalTable from "../src/lints/static/shape-targets-global-table";
import shapeUnknownTable from "../src/lints/static/shape-unknown-table";

/**
 * `messages` is sharded (poke-live eligible), `users` is `.global()` (lives in
 * D1 — the cross-shard tier), `settings` is a default root table.
 */
const schema = () =>
    fromServerSchema(
        defineSchema({
            messages: defineTable({ channelId: v.string(), text: v.string() }).shardBy("channelId"),
            settings: defineTable({ value: v.string() }),
            users: defineTable({ email: v.string() }).global(),
        }),
    );

const shape = (overrides: Partial<AdvisorShape> = {}): AdvisorShape => {
    return { exportName: "channelMessages", file: "lunora/shapes.ts", table: "messages", ...overrides };
};

describe("shape_unknown_table", () => {
    it("finds nothing when no shapes evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(shapeUnknownTable.run({ schema: schema() })).toHaveLength(0);
    });

    it("finds nothing when every shape table exists in the schema", () => {
        expect.assertions(1);

        const shapes = [shape(), shape({ exportName: "allUsers", table: "users" })];

        expect(shapeUnknownTable.run({ schema: schema(), shapes })).toHaveLength(0);
    });

    it("flags a shape bound to a table that does not exist in the schema", () => {
        expect.assertions(3);

        // "message" (singular) is a typo for the real "messages" table.
        const findings = shapeUnknownTable.run({ schema: schema(), shapes: [shape({ exportName: "typo", table: "message" })] });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "shape_unknown_table:typo",
            level: "ERROR",
            metadata: { exportName: "typo", table: "message" },
            name: "shape_unknown_table",
        });
        expect(findings[0]?.detail).toContain("message");
    });

    it("skips a shape whose table literal the feeder could not resolve", () => {
        expect.assertions(1);

        expect(shapeUnknownTable.run({ schema: schema(), shapes: [shape({ table: undefined })] })).toHaveLength(0);
    });
});

describe("shape_targets_global_table", () => {
    it("finds nothing when no shapes evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(shapeTargetsGlobalTable.run({ schema: schema() })).toHaveLength(0);
    });

    it("flags a shape replicating from a `.global()` table (the poll-tier boundary)", () => {
        expect.assertions(3);

        const findings = shapeTargetsGlobalTable.run({ schema: schema(), shapes: [shape({ exportName: "allUsers", table: "users" })] });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "shape_targets_global_table:allUsers",
            categories: ["PERFORMANCE"],
            level: "WARN",
            metadata: { exportName: "allUsers", table: "users" },
            name: "shape_targets_global_table",
        });
        expect(findings[0]?.detail).toContain("poke-live");
    });

    it("does not flag a shape over a sharded or root table (poke-live eligible)", () => {
        expect.assertions(1);

        const shapes = [shape(), shape({ exportName: "appSettings", table: "settings" })];

        expect(shapeTargetsGlobalTable.run({ schema: schema(), shapes })).toHaveLength(0);
    });

    it("skips a shape whose table literal the feeder could not resolve", () => {
        expect.assertions(1);

        expect(shapeTargetsGlobalTable.run({ schema: schema(), shapes: [shape({ table: undefined })] })).toHaveLength(0);
    });
});
