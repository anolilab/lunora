import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorKvKeyAccess } from "../src/kv-key-accesses";
import kvUnscopedUserKeyIdor from "../src/lints/static/kv-unscoped-user-key-idor";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("kv_unscoped_user_key_idor", () => {
    it("flags one ERROR finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const kvKeyAccesses: AdvisorKvKeyAccess[] = [
            { exportName: "readEntry", file: "entries", line: 4, method: "get" },
            { exportName: "writeEntry", file: "entries", line: 9, method: "put" },
        ];
        const findings = kvUnscopedUserKeyIdor.run({ kvKeyAccesses, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "kv_unscoped_user_key_idor:entries:4",
            level: "ERROR",
            metadata: { exportName: "readEntry", method: "get" },
            name: "kv_unscoped_user_key_idor",
        });
        expect(findings[0]?.detail).toContain("ctx.kv.get");
        expect(findings[1]?.cacheKey).toBe("kv_unscoped_user_key_idor:entries:9");
    });

    it("finds nothing when the feeder supplies no KV evidence", () => {
        expect.assertions(2);

        expect(kvUnscopedUserKeyIdor.run({ schema: schema() })).toHaveLength(0);
        expect(kvUnscopedUserKeyIdor.run({ kvKeyAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
