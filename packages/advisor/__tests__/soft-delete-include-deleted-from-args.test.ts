import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import softDeleteIncludeDeletedFromArgs from "../src/lints/static/soft-delete-include-deleted-from-args";
import type { AdvisorSoftDeleteRead } from "../src/soft-delete-reads";

const schema = () =>
    fromServerSchema(
        defineSchema({
            comments: defineTable({ body: v.string() }),
            posts: defineTable({ title: v.string() }).softDelete(),
        }),
    );

const rows: AdvisorSoftDeleteRead[] = [
    // public read hardcoding includeDeleted: true on a soft-delete table → flagged (literal).
    { exportName: "listTrash", file: "trash", fromArgs: false, hardcodedTrue: true, line: 3, table: "posts", visibility: "public" },
    // public read wiring includeDeleted from args on a soft-delete table → flagged (args).
    { exportName: "listPosts", file: "list", fromArgs: true, hardcodedTrue: false, line: 5, table: "posts", visibility: "public" },
    // internal read → exempt.
    { exportName: "adminTrash", file: "admin", fromArgs: false, hardcodedTrue: true, line: 7, table: "posts", visibility: "internal" },
    // public read on a table that does not soft-delete → not flagged.
    { exportName: "listComments", file: "comments", fromArgs: false, hardcodedTrue: true, line: 9, table: "comments", visibility: "public" },
];

describe("soft_delete_include_deleted_from_args", () => {
    it("flags only public reads whose target actually soft-deletes", () => {
        expect.assertions(2);

        const findings = softDeleteIncludeDeletedFromArgs.run({ schema: schema(), softDeleteReads: rows });

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.metadata?.exportName)).toStrictEqual(["listTrash", "listPosts"]);
    });

    it("tags the hardcoded-true read as a literal source", () => {
        expect.assertions(2);

        const finding = softDeleteIncludeDeletedFromArgs
            .run({ schema: schema(), softDeleteReads: rows })
            .find((row) => row.metadata?.exportName === "listTrash");

        expect(finding).toMatchObject({ level: "INFO", metadata: { source: "literal", table: "posts" }, name: "soft_delete_include_deleted_from_args" });
        expect(finding?.detail).toContain("includeDeleted: true");
    });

    it("tags the args-derived read as an args source", () => {
        expect.assertions(2);

        const finding = softDeleteIncludeDeletedFromArgs
            .run({ schema: schema(), softDeleteReads: rows })
            .find((row) => row.metadata?.exportName === "listPosts");

        expect(finding).toMatchObject({ level: "INFO", metadata: { source: "args", table: "posts" }, name: "soft_delete_include_deleted_from_args" });
        expect(finding?.detail).toContain("args");
    });

    it("returns [] when softDeleteReads is undefined", () => {
        expect.assertions(1);

        expect(softDeleteIncludeDeletedFromArgs.run({ schema: schema() })).toHaveLength(0);
    });
});
