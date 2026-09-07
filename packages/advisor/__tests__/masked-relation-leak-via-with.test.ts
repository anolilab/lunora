import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import maskedRelationLeakViaWith from "../src/lints/static/masked-relation-leak-via-with";
import type { AdvisorMaskProcedure } from "../src/mask-procedures";
import type { AdvisorRelationLoad } from "../src/relation-loads";

const schema = () =>
    fromServerSchema(
        defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ email: v.string(), name: v.string() }),
        }),
    );

// `users` is masked (email redacted) on its own reads.
const maskProcedures: AdvisorMaskProcedure[] = [
    {
        exportName: "listUsers",
        file: "users",
        maskColumns: [{ column: "email", table: "users" }],
        tablesRead: ["users"],
        tablesWritten: [],
        usesMask: true,
        visibility: "public",
    },
];

const relationLoads: AdvisorRelationLoad[] = [
    // public read pulling the masked `users` table in via `with: { author }` → flagged.
    { exportName: "listPosts", file: "list", line: 3, parentTable: "posts", relations: ["author"], visibility: "public" },
    // internal read → exempt.
    { exportName: "adminList", file: "admin", line: 5, parentTable: "posts", relations: ["author"], visibility: "internal" },
    // an unknown relation accessor that resolves to no schema relation → skipped.
    { exportName: "listGhost", file: "ghost", line: 7, parentTable: "posts", relations: ["ghost"], visibility: "public" },
];

describe("masked_relation_leak_via_with", () => {
    it("flags a public read that hydrates a masked relation through with", () => {
        expect.assertions(2);

        const findings = maskedRelationLeakViaWith.run({ maskProcedures, relationLoads, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "INFO",
            metadata: { exportName: "listPosts", parentTable: "posts", relation: "author", relationTable: "users" },
            name: "masked_relation_leak_via_with",
        });
    });

    it("does not flag when the relation's target table is not masked", () => {
        expect.assertions(1);

        expect(maskedRelationLeakViaWith.run({ maskProcedures: [], relationLoads, schema: schema() })).toHaveLength(0);
    });

    it("returns [] when relationLoads is undefined", () => {
        expect.assertions(1);

        expect(maskedRelationLeakViaWith.run({ maskProcedures, schema: schema() })).toHaveLength(0);
    });

    /**
     * The relation loader calls the READING procedure's `relationMask` for the
     * target table of every hop, so a parent read whose own policy names `users`
     * gets masked authors back. Flagging it is a false positive.
     */
    it("does not flag a read whose own mask policy covers the related table", () => {
        expect.assertions(1);

        const selfMasking: AdvisorMaskProcedure[] = [
            ...maskProcedures,
            {
                exportName: "listPosts",
                file: "list",
                maskColumns: [{ column: "email", table: "users" }],
                tablesRead: ["posts"],
                tablesWritten: [],
                usesMask: true,
                visibility: "public",
            },
        ];

        expect(maskedRelationLeakViaWith.run({ maskProcedures: selfMasking, relationLoads, schema: schema() })).toHaveLength(0);
    });

    it("still flags a read whose own mask policy names only the parent table", () => {
        expect.assertions(1);

        const parentOnly: AdvisorMaskProcedure[] = [
            ...maskProcedures,
            {
                exportName: "listPosts",
                file: "list",
                maskColumns: [{ column: "title", table: "posts" }],
                tablesRead: ["posts"],
                tablesWritten: [],
                usesMask: true,
                visibility: "public",
            },
        ];

        expect(maskedRelationLeakViaWith.run({ maskProcedures: parentOnly, relationLoads, schema: schema() })).toHaveLength(1);
    });

    // `usesMask` with no readable `maskColumns` means the policy argument was
    // opaque — it could name `users`, so this must not flag.
    it("does not flag a read whose mask policy could not be read statically", () => {
        expect.assertions(1);

        const opaque: AdvisorMaskProcedure[] = [
            ...maskProcedures,
            { exportName: "listPosts", file: "list", maskColumns: [], tablesRead: ["posts"], tablesWritten: [], usesMask: true, visibility: "public" },
        ];

        expect(maskedRelationLeakViaWith.run({ maskProcedures: opaque, relationLoads, schema: schema() })).toHaveLength(0);
    });
});
