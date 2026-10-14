import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a secondary index declared with no columns (`.index("x", [])`). The
 * `.index(name, fields)` builder types `fields` as `string[]`, not
 * `keyof Shape[]`, so an empty array slips past the compiler — but an index over
 * zero columns indexes nothing and can never narrow a read. Almost always a
 * leftover from a refactor. (Search / rank / vector indexes always carry at
 * least one field by construction, so only `kind: "index"` is checked.)
 */
const emptyIndex: Lint = {
    categories: ["SCHEMA"],
    description: "An index declares no columns, so it indexes nothing and can never narrow a read.",
    facing: "INTERNAL",
    level: "WARN",
    name: "empty_index",
    remediation: "Give the index its columns, or remove it.",
    run: (context) =>
        context.schema.tables.flatMap((table) =>
            table.indexes
                .filter((index) => index.kind === "index" && index.fields.length === 0)
                .map((index) =>
                    emit(emptyIndex, {
                        cacheKey: `empty_index:${table.name}:${index.name}`,
                        detail: `Index "${index.name}" on table "${table.name}" declares no columns.`,
                        metadata: { index: index.name, table: table.name },
                    }),
                ),
        ),
    source: "static",
    title: "Empty index",
};

export default emptyIndex;
