import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import ttlFieldNotTimestamp from "../src/lints/static/ttl-field-not-timestamp";
import type { AdvisorSchema } from "../src/schema";

const run = (schema: ReturnType<typeof defineSchema>) => ttlFieldNotTimestamp.run({ schema: fromServerSchema(schema) });

describe("ttl_field_not_timestamp", () => {
    it("passes when the TTL field is a timestamp", () => {
        expect.assertions(1);

        const schema = defineSchema({
            sessions: defineTable({ expiresAt: v.timestamp(), token: v.string() }).ttl("expiresAt"),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes when the TTL field is a plain epoch-ms number", () => {
        expect.assertions(1);

        const schema = defineSchema({
            sessions: defineTable({ expiresAt: v.number(), token: v.string() }).ttl("expiresAt"),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("flags a TTL field that is a string", () => {
        expect.assertions(2);

        const schema = defineSchema({
            sessions: defineTable({ expiresAt: v.string(), token: v.string() }).ttl("expiresAt"),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "ERROR",
            name: "ttl_field_not_timestamp",
            categories: ["SCHEMA"],
            cacheKey: "ttl_field_not_timestamp:sessions:expiresAt",
            metadata: { field: "expiresAt", kind: "string", table: "sessions" },
        });
    });

    it("ignores a TTL field that names an Object.prototype member but no declared column", () => {
        expect.assertions(1);

        // A bare `columnKinds[field]` index read resolves "toString" to the
        // inherited function, which is neither undefined nor a time kind — an
        // ERROR whose detail reads "is a function toString() { [native code] }".
        const schema: AdvisorSchema = {
            tables: [{ columnKinds: { token: "string" }, fields: ["token"], indexes: [], name: "sessions", relations: [], ttl: { field: "toString" } }],
        };

        expect(ttlFieldNotTimestamp.run({ schema })).toHaveLength(0);
    });

    it("ignores tables without a TTL policy", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });
});
