import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover-schema";
import { emitShard } from "../src/emit";

/**
 * Codegen emission for `.source(...)` external-source ingest (plan 077). Everything
 * is gated on the schema having a sourced table, so a non-sourced schema's `shard.ts`
 * is byte-identical (no `pollExternalSources`, no `sourceClient` config). A sourced
 * schema gains: the poll override, the alarm-arming constructor, the per-binding
 * client memo, the `runExternalSourceTick` import, and the `sourceClient` config seam.
 */

const discover = (source: string) => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, source);

    return discoverSchema(project, schemaPath);
};

const SOURCED = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        documents: defineTable({ orgId: v.string(), title: v.string() })
            .shardBy("orgId")
            .source({ binding: "HD", query: "select id, title, org_id from documents where org_id = $1", tenantBy: (key) => [key] }),
    });
`;

const PLAIN = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        documents: defineTable({ title: v.string() }).shardBy("title"),
    });
`;

describe("emitShard — external-source ingest", () => {
    it("emits the poll override, arming constructor, client memo, import and config seam for a sourced schema", () => {
        expect.assertions(6);

        const shard = emitShard({ schema: discover(SOURCED) });

        expect(shard).toContain("protected override async pollExternalSources()");
        expect(shard).toContain("runExternalSourceTick(this.sql as SqlExec, writer");
        expect(shard).toContain("void this.scheduleSourcePoll();");
        expect(shard).toContain("const sourceClientCache = new WeakMap");
        // The host-supplied resolver seam on the config interface.
        expect(shard).toContain("sourceClient?: (env: Record<string, unknown>, binding: string)");
        // The runExternalSourceTick import is pulled from the base DO package.
        expect(shard).toContain("runExternalSourceTick,");
    });

    it("stays byte-identical (none of the ingest surface) for a non-sourced schema", () => {
        expect.assertions(3);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).not.toContain("pollExternalSources");
        expect(shard).not.toContain("sourceClient");
        expect(shard).not.toContain("scheduleSourcePoll");
    });
});
