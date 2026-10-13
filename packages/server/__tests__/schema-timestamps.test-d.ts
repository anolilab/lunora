/**
 * Compile-time only (included by `tsc --noEmit`): `.timestamps()` adds its column
 * to the builder's `Shape`, so the rest of the chain can index or expire by it.
 * Chains live in a function body to keep the file `--isolatedDeclarations`-clean.
 */
import { v } from "@lunora/values";

import { defineTable } from "../src/schema";

const check = (): void => {
    defineTable({ title: v.string() }).timestamps().index("by_updated", ["updatedAt"]);
    defineTable({ title: v.string() }).timestamps().ttl("updatedAt", { after: 1000 });
    defineTable({ title: v.string() }).timestamps({ field: "modifiedAt" }).index("by_modified", ["modifiedAt"]);
    // A column the author already declared keeps its own type and still indexes.
    defineTable({ updatedAt: v.number() }).timestamps().index("by_updated", ["updatedAt"]);

    // The column only exists from `.timestamps()` onward, so an earlier `.index()` cannot name it.
    // @ts-expect-error -- `updatedAt` is not a field yet when `.index()` runs
    defineTable({ title: v.string() }).index("by_updated", ["updatedAt"]).timestamps();
    // @ts-expect-error -- the default name is not added when a custom field is requested
    defineTable({ title: v.string() }).timestamps({ field: "modifiedAt" }).index("by_updated", ["updatedAt"]);
};

export default check;
