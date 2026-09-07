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

    // ERROR is the build-failing tier (`strictAdvisories` defaults on in CI), and
    // "any caller can read/overwrite/delete another user's entry" is false by
    // construction for a procedure no caller can reach. Mirrors the identical
    // split on `storage_key_from_user_args` / `owner_field_from_args_not_auth`.
    it("drops an internal procedure's access to INFO/INTERNAL instead of the build-failing ERROR", () => {
        expect.assertions(3);

        const kvKeyAccesses: AdvisorKvKeyAccess[] = [{ exportName: "warmCache", file: "cache", line: 12, method: "put", visibility: "internal" }];
        const findings = kvUnscopedUserKeyIdor.run({ kvKeyAccesses, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "kv_unscoped_user_key_idor:cache:12",
            facing: "INTERNAL",
            level: "INFO",
            metadata: { exportName: "warmCache", visibility: "internal" },
        });
        expect(findings[0]?.detail).toContain("expected for an `internal` procedure");
    });

    it("keeps a public access at ERROR, and records an unattributed one as unknown", () => {
        expect.assertions(3);

        const kvKeyAccesses: AdvisorKvKeyAccess[] = [
            { exportName: "readEntry", file: "entries", line: 4, method: "get", visibility: "public" },
            { exportName: "orphan", file: "entries", line: 7, method: "get" },
        ];
        const findings = kvUnscopedUserKeyIdor.run({ kvKeyAccesses, schema: schema() });

        expect(findings[0]).toMatchObject({ facing: "EXTERNAL", level: "ERROR", metadata: { visibility: "public" } });
        expect(findings[1]).toMatchObject({ level: "ERROR", metadata: { visibility: "unknown" } });
        expect(findings[1]?.detail).toContain("(IDOR)");
    });

    it("finds nothing when the feeder supplies no KV evidence", () => {
        expect.assertions(2);

        expect(kvUnscopedUserKeyIdor.run({ schema: schema() })).toHaveLength(0);
        expect(kvUnscopedUserKeyIdor.run({ kvKeyAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
