import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import storageKeyFromUserArgs from "../src/lints/static/storage-key-from-user-args";
import type { AdvisorStorageKeyAccess } from "../src/storage-key-accesses";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("storage_key_from_user_args", () => {
    it("flags one ERROR finding per storage-key evidence row", () => {
        expect.assertions(3);

        const storageKeyAccesses: AdvisorStorageKeyAccess[] = [
            { exportName: "getDoc", file: "docs", line: 4, method: "get" },
            { exportName: "removeDoc", file: "docs", line: 9, method: "delete" },
        ];
        const findings = storageKeyFromUserArgs.run({ schema: schema(), storageKeyAccesses });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "storage_key_from_user_args:docs:4",
            level: "ERROR",
            metadata: { exportName: "getDoc", method: "get" },
            name: "storage_key_from_user_args",
        });
        expect(findings[1]).toMatchObject({ cacheKey: "storage_key_from_user_args:docs:9", name: "storage_key_from_user_args" });
    });

    it("finds nothing when the feeder supplies no storage-key evidence", () => {
        expect.assertions(2);

        expect(storageKeyFromUserArgs.run({ schema: schema() })).toHaveLength(0);
        expect(storageKeyFromUserArgs.run({ schema: schema(), storageKeyAccesses: [] })).toHaveLength(0);
    });
});
