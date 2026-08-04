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

    // Issue #284: both real-world false positives were `internalAction`s
    // receiving a content-addressed storage id minted server-side. An
    // `internal*` procedure has no untrusted caller by construction, so the
    // "any caller can read/overwrite/delete another user's object" premise is
    // eslint-disable-next-line no-secrets/no-secrets -- false positive: a lint NAME quoted in prose, not a credential
    // false there — mirrors `owner_field_from_args_not_auth`'s visibility split.
    it("drops an internal procedure's access to INFO and redirects it at the public callers", () => {
        expect.assertions(5);

        const storageKeyAccesses: AdvisorStorageKeyAccess[] = [
            { exportName: "extractDocumentText", file: "agent/extraction", line: 104, method: "getUrl", visibility: "internal" },
            { exportName: "getDoc", file: "docs", line: 4, method: "get", visibility: "public" },
        ];
        const findings = storageKeyFromUserArgs.run({ schema: schema(), storageKeyAccesses });

        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { visibility: "internal" } });
        expect(findings[0]?.detail).toContain("Audit the PUBLIC procedures");
        expect(findings[0]?.detail).toContain("expected for an `internal` procedure");

        // The public-facing case is untouched and still blocks.
        expect(findings[1]).toMatchObject({ level: "ERROR", metadata: { visibility: "public" } });
        expect(findings[1]?.detail).toContain("any caller can read/overwrite/delete another user's object");
    });

    it("keeps ERROR when the feeder could not attribute a visibility", () => {
        expect.assertions(1);

        const storageKeyAccesses: AdvisorStorageKeyAccess[] = [{ exportName: "helper", file: "lib", line: 3, method: "get" }];

        expect(storageKeyFromUserArgs.run({ schema: schema(), storageKeyAccesses })[0]).toMatchObject({ level: "ERROR" });
    });
});
