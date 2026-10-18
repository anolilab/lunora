import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * A `.unique()` index added over rows that already hold duplicates cannot be
 * built. If the cold-start migration threw for it, the shard would never open and
 * the de-dup data migration (an admin call, which migrates first) could never
 * run. So the emitted shard defers the blocked index: the admin path migrates the
 * rest, and only user dispatch refuses until the index exists.
 */
const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

/** The body of the emitted method starting at `signature`, up to its closing brace. */
const methodBody = (signature: string): string => {
    const start = emitted.indexOf(signature);

    if (start === -1) {
        throw new Error(`emitted shard has no ${signature}`);
    }

    return emitted.slice(start, emitted.indexOf("\n        }", start));
};

describe("emitShard — blocked unique index", () => {
    it("migrates the base schema without throwing for a blocked unique index", () => {
        expect.assertions(4);

        const body = methodBody("protected override ensureMigrated()");

        expect(body).toContain("deferBlockedUniqueIndexes: true");
        expect(body).toContain("this.blockedUniqueIndexes = runShardMigrations(");
        expect(body).toContain("this.migrated = this.blockedUniqueIndexes.length === 0;");
        expect(body).not.toContain("throw");
    });

    it("refuses user dispatch while an index is outstanding", () => {
        expect.assertions(2);

        expect(methodBody("private ensureServable()")).toContain('throw new LunoraError("INTERNAL", this.blockedUniqueIndexes.join("; "))');
        expect(methodBody("public override async handleRpc(")).toContain("this.ensureServable();");
    });

    it("keeps the admin data-migration path on the tolerant migrate", () => {
        expect.assertions(2);

        const body = methodBody("protected override async runShardDataMigration(");

        expect(body).toContain("this.ensureMigrated();");
        expect(body).not.toContain("ensureServable");
    });
});
