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
        expect.assertions(14);

        const shard = emitShard({ schema: discover(SOURCED) });

        expect(shard).toContain("protected override async pollExternalSources(trace?: TraceRefLike)");
        // The per-table work delegates to the tested @lunora/do helper, not an inline projection.
        expect(shard).toContain("pullExternalSourceTick(this.sql as SqlExec, writer, client");
        // Incremental mode (plan 136) branches to the durable-watermark helper.
        expect(shard).toContain('source.mode === "incremental"');
        // eslint-disable-next-line no-secrets/no-secrets -- the emitted poll-loop identifier, not a credential
        expect(shard).toContain("pullExternalSourceIncrementalTick(this.sql as SqlExec, writer, client");
        expect(shard).toContain("isSourceDue(source.refresh, polledAt.get(table), now)");
        // The constructor only arms the alarm when a non-manual source exists (refresh: "manual" must not spin it).
        expect(shard).toContain('source.refresh !== "manual"');
        expect(shard).toContain("void this.scheduleSourcePoll();");
        expect(shard).toContain("const sourceClientCache = new WeakMap");
        // The poll helpers are imported from the base DO package.
        expect(shard).toContain("isSourceDue, pullExternalSourceIncrementalTick, pullExternalSourceTick,");
        // Plan 148: the override reports the earliest NEXT-DUE timestamp (not a
        // bare active count), so the shared alarm can sleep until a source is
        // actually due instead of spinning at the 2 s global-shape floor.
        expect(shard).toContain("protected override async pollExternalSources(trace?: TraceRefLike): Promise<number | undefined>");
        expect(shard).toContain("nextDueAt = nextDueAt === undefined ? sourceNextDueAt : Math.min(nextDueAt, sourceNextDueAt);");
        // Plan 207 step 2: each table's writer gets its OWN fresh per-work-item
        // meter — an alarm tick has no `/rpc` dispatch to fall back to.
        expect(shard).toContain("headroom: this.alarmHeadroom()");
        // A meter cap mid-batch is "batch full", not a genuine source failure: it
        // warns (not `recordExternalSourceError`) and leaves the table due so the
        // shared alarm re-arms promptly instead of throttling to `refresh.everyMs`.
        expect(shard).toContain('error instanceof LunoraError && error.code === "TRANSACTION_LIMIT_EXCEEDED"');
        // The `warn` level itself is the base class's (`recordExternalSourceWarning`);
        // what the emitter owns is routing the back-off there rather than to
        // `recordExternalSourceError`, which would group it as a real Issue.
        expect(shard).toContain("this.recordExternalSourceWarning(");
    });

    it("forwards the alarm's trace to every contained ingest failure it records", () => {
        expect.assertions(4);

        const shard = emitShard({ schema: discover(SOURCED) });

        // The parameter is only worth having if all three log sites in the
        // generated poll loop actually pass it on — a signature that accepts a
        // trace and drops it would leave these lines uncorrelated exactly as
        // before, and the type-checker would not notice.
        expect(shard).toContain("this.recordExternalSourceError(table, error, trace);");
        // A regex so the emitted `${source.binding}` interpolation stays out of a
        // string literal (`no-template-curly-in-string`).
        expect(shard).toMatch(/no sourceClient resolved for binding[^\n]*, trace\);/u);
        expect(shard).toContain("this.recordExternalSourceWarning(");
        // Structural projection from the base package, so a generated app never
        // takes on an `@lunora/observability` dependency for this.
        expect(shard).toContain("import type { ExternalSourceLike, SourceClientLike, TraceRefLike }");
    });

    it("only touches base-class members the compile-time contract covers", () => {
        expect.assertions(1);

        // The emitted shard is a string, so nothing type-checks it — which is how
        // `this.logs.push(...)` (private on `ShardDO`) shipped in the poll loop for
        // the life of this feature. `emitted-shard-contract.ts` compiles a subclass
        // using each member below, so `lint:types` fails if one changes visibility
        // or signature; this asserts the emitter still restricts itself to that set.
        //
        // Adding a member here means adding it to the contract file too — that
        // pairing is the whole guard. Members read off `this` inside the emitted
        // poll loop, ignoring locals and the `schema`/`config` module closures.
        const membersOf = (shard: string): Set<string> => new Set([...shard.matchAll(/\bthis\.([A-Za-z_]\w*)/gu)].map((match) => match[1] as string));

        const plain = membersOf(emitShard({ schema: discover(PLAIN) }));
        const added = [...membersOf(emitShard({ schema: discover(SOURCED) }))].filter((member) => !plain.has(member)).toSorted((a, b) => a.localeCompare(b));

        expect(added).toStrictEqual(["alarmHeadroom", "currentShardKey", "recordExternalSourceError", "recordExternalSourceWarning", "scheduleSourcePoll"]);
    });

    it("stays byte-identical (none of the ingest surface) for a non-sourced schema", () => {
        expect.assertions(3);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).not.toContain("pollExternalSources");
        expect(shard).not.toContain("sourceClient");
        expect(shard).not.toContain("scheduleSourcePoll");
    });
});
