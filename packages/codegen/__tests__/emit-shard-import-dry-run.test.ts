import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/** The emitted `runShardImport` override, from its signature up to the write it hands to the importer. */
const importBlock = (emitted: string): string => {
    const start = emitted.indexOf("protected override async runShardImport");

    return emitted.slice(start, emitted.indexOf("importShardRows(writer", start));
};

describe("emitShard — runShardImport dry run", () => {
    it("migrates only for a real import, so a dry run never writes the schema ledger of a cold shard", () => {
        expect.assertions(1);

        // A dry run only checks row shapes, but `ensureMigrated` writes the schema ledger and creates tables. Gating the call on the flag
        // keeps the check from changing a shard it is only meant to inspect.
        expect(importBlock(emitShard({ schema: { tables: [], vectorIndexes: [] } }))).toMatch(
            /if \(args\.dryRun !== true\) \{\s*this\.ensureMigrated\(\);\s*\}/u,
        );
    });
});
