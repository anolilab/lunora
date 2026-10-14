import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";
import type { TableIR } from "../src/ir";

/**
 * The emitted `runShardInit` override — the generated half of `.memory()` and
 * `onShardInit`.
 *
 * The ordering it encodes is the feature's only real hazard: memory tables are
 * cleared, then the init hooks refill them, and the DO base awaits the whole
 * thing before user code runs. A regression here does not throw — it serves a
 * silently empty table — so the emitted text is worth pinning.
 */
const table = (overrides: Partial<TableIR> & { name: string }): TableIR => {
    return {
        indexes: [],
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape: {},
        shardMode: "root",
        vectorIndexes: [],
        ...overrides,
    };
};

const shardFor = (tables: TableIR[]): string => emitShard({ schema: { tables, vectorIndexes: [] } });

const initBlock = (emitted: string): string => {
    const start = emitted.indexOf("protected override async runShardInit");

    return emitted.slice(start, emitted.indexOf("\n        }", start));
};

describe("emitShard — runShardInit override", () => {
    it("is always emitted, even with no memory tables and no hooks", () => {
        expect.assertions(2);

        const emitted = shardFor([]);

        // Gating this at emit time would mean a project that adds its first
        // `onShardInit` to a shard generated before the flag existed silently
        // never fires it. `dispatchShardInit` over an empty manifest costs nothing.
        expect(emitted).toContain("protected override async runShardInit(): Promise<void>");
        expect(initBlock(emitted)).toContain("await this.dispatchShardInit();");
    });

    it("migrates before clearing, because the clear is a DELETE on a table that must exist", () => {
        expect.assertions(1);

        // On a cold start this is the earliest code to touch SQL, ahead of the
        // dispatch that would otherwise have migrated.
        expect(initBlock(shardFor([table({ memory: true, name: "presence" })]))).toContain("this.ensureMigrated();");
    });

    it("clears memory tables before dispatching the hooks", () => {
        expect.assertions(2);

        const block = initBlock(shardFor([table({ memory: true, name: "presence" })]));

        expect(block).toContain("clearMemoryTables(this.sql as SqlExec, schema as unknown as SchemaLike);");
        // Order is the contract: a hook exists to refill what the clear emptied.
        expect(block.indexOf("clearMemoryTables")).toBeLessThan(block.indexOf("dispatchShardInit"));
    });

    it("omits the clear — and its import — when no table is a memory table", () => {
        expect.assertions(2);

        const emitted = shardFor([table({ name: "orders" })]);

        expect(initBlock(emitted)).not.toContain("clearMemoryTables");
        // Keeps the symbol off the import list of every shard that has no use
        // for it, which is most of them.
        expect(emitted).not.toContain("clearMemoryTables,");
    });

    it("pulls the clear in as soon as one table declares .memory()", () => {
        expect.assertions(1);

        expect(shardFor([table({ name: "orders" }), table({ memory: true, name: "presence" })])).toContain("clearMemoryTables,");
    });
});
