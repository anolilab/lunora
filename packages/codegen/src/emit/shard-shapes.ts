import type { RlsPoliciesResult } from "@lunora/shard-engine";

/**
 * The emitted ShardDO's local-first sync overrides — `resolveShape`, the
 * custom-mutator watermark guard, the boot-time shape read-policy check — and
 * their import fragments. Split out of `emitShard`; every fragment is empty
 * for a shape/mutator-free project.
 */
const emitShapeFragments = ({
    hasMutators,
    hasShapes,
    rlsData,
}: {
    hasMutators: boolean;
    hasShapes: boolean;
    rlsData: RlsPoliciesResult;
}): {
    customMutatorOverride: string;
    shapeGuardImport: string;
    shapeReadPolicyAssertion: string;
    shapeReadPolicyImport: string;
    shapeResolveOverride: string;
} => {
    // Local-first sync engine: the DO overrides that route `shape_subscribe`
    // (`resolveShape`) and the client-watermark mutator push (`isCustomMutator`)
    // through the generated registries. Both are empty for a shape/mutator-free
    // project, so its `shard.ts` is byte-identical.
    /* eslint-disable no-secrets/no-secrets -- the emitted resolveShape body + registry builder are dense generated TS (`composeShapeReadWhere(LUNORA_RLS_READ_REGISTRY, …)`), not credentials */
    const shapeResolveOverride = hasShapes
        ? `
        protected override resolveShape(name: string, args: Record<string, unknown>, identity?: SubscriptionIdentity): { columns?: readonly string[]; effectiveWhere?: WhereInput; global?: boolean; table: string } | undefined {
            const shape = LUNORA_SHAPES[name];

            if (!shape) {
                return undefined;
            }

            this.ensureMigrated();

            // Trusted ctx from the socket's OWN verified identity — the client
            // supplies only the shape name + args; \`compileWhere\` validates the
            // args then runs the shape's \`where(ctx, args)\` under that identity,
            // so which rows replicate is a server decision (reads-as-permissions).
            const ctx = this.buildCtx({ functionPath: \`__shape__:\${name}\`, identity });
            // \`ownerField\` resolves an \`owner: true\` shape: only here is the table's
            // \`.ownedBy(field)\` column in scope, so the DO hands it to the shape
            // rather than every shape restating the ownership check in its \`where\`.
            const shapeWhere = shape.compileWhere(ctx, args, {
                ownerField: (schema as unknown as { tables: Record<string, { ownerField?: string }> }).tables[shape.table]?.ownerField,
            }) as unknown as WhereInput;

            // AND-compose with the read policies this SHAPE declares
            // (\`defineShape({ use: [guard] })\`, pre-indexed into
            // \`shape.rlsRegistry\`). A shape runs no procedure, so the
            // \`.use(rls(...))\` middleware never fires; without this merge its
            // reads would bypass the read policies it opted into.
            // \`composeShapeReadWhere\` evaluates them under this same trusted ctx
            // and fails closed under a \`.rls("required")\` schema for a
            // non-\`.public()\` table the shape declared no read policy for.
            //
            // The registry is the shape's OWN — never one folded from every
            // registered function. A project-wide union let one admin-only
            // procedure's allow-all read policy unrestrict every shape on the
            // table; see the SCOPE note in \`shape-read-base.ts\`.
            //
            // It is NOT identical to the request-time path, and must not be
            // described as such: roles come from the identity's \`roles\` claim
            // only, because no middleware runs here to contribute
            // \`ctx.auth.roles\`. Derive roles at the identity if a policy gates
            // on them — see \`shape-read-base.ts\`.
            const effectiveWhere = composeShapeReadWhere(shape.rlsRegistry, {
                ctx,
                identity: identity?.identity ?? null,
                rlsRequired: (schema as unknown as { rlsMode?: string }).rlsMode === "required",
                shapeWhere,
                table: shape.table,
                tablePublic: (schema as unknown as { tables: Record<string, { isPublic?: boolean }> }).tables[shape.table]?.isPublic === true,
                userId: identity?.userId ?? null,
            });

            // A live shape pokes only from its OWN shard's op-log, so a \`where()\`
            // that joins to a \`.shardBy()\` table (rows in another DO) is rejected
            // here — the first point the compiled predicate + shard modes are both
            // known. Remedy: denormalize, or move the joined table to \`.global()\`.
            assertShapeShardable(effectiveWhere, schema as unknown as SchemaLike, shape.table);

            // A \`.global()\` table lives in D1 (no per-DO op-log): flag it so the
            // base serves it through the latency-tiered poll path (\`readGlobalShapeRows\`)
            // instead of the CDC poke path.
            const isGlobal = (schema as unknown as SchemaLike).tables[shape.table]?.shardMode?.kind === "global";

            return { columns: shape.columns, effectiveWhere, global: isGlobal, table: shape.table };
        }
`
        : "";
    // Boot-time fail-closed check for the OTHER direction of shape RLS scoping: a
    // shape whose table the project governs on read but that names no `use` has an
    // empty registry, so it replicates on its own `where` alone — unfiltered, with
    // no error. Only the runtime registry knows whether `use` was written (the
    // shape IR does not lift it), so the tables come from codegen and the verdict
    // from `@lunora/server`. Emitted only when both halves exist, so a project
    // without shapes or without read policies keeps a byte-identical `shard.ts`.
    const shapeReadPolicyTables = hasShapes
        ? [...new Set(rlsData.policies.filter((policy) => policy.on === "read" && policy.table !== "").map((policy) => policy.table))].toSorted((a, b) =>
              a.localeCompare(b),
          )
        : [];
    const shapeReadPolicyAssertion =
        shapeReadPolicyTables.length > 0
            ? `
/** Refuses to boot a shape that would replicate around the read policies its table is governed by (\`defineShape({ use })\` is how a shape opts in; \`use: []\` acknowledges an ungoverned one). */
assertShapesDeclareReadPolicies(LUNORA_SHAPES, ${JSON.stringify(shapeReadPolicyTables)}, (schema as unknown as { rlsMode?: string }).rlsMode === "required");
`
            : "";

    const customMutatorOverride = hasMutators
        ? `
        protected override isCustomMutator(functionPath: string): boolean {
            return LUNORA_MUTATOR_PATHS.has(functionPath);
        }
`
        : "";

    /* eslint-enable no-secrets/no-secrets */

    // The cross-shard-join guard (`assertShapeShardable`) is a value import,
    // pulled in only when the project has shapes so a shape-free `shard.ts`
    // stays byte-identical.
    const shapeGuardImport = hasShapes ? "assertShapeShardable, " : "";
    // Imported only when the boot-time check is actually stamped: an unused import in
    // generated output fails the strict `noUnusedLocals` config it compiles under.
    const shapeReadPolicyImport = shapeReadPolicyAssertion === "" ? "" : "assertShapesDeclareReadPolicies, ";

    return { customMutatorOverride, shapeGuardImport, shapeReadPolicyAssertion, shapeReadPolicyImport, shapeResolveOverride };
};

/** The `readGlobalShapeRows` override, reading through `globalDatabaseThunk`; empty unless `enabled`. */
const emitGlobalShapeReaderOverride = (enabled: boolean, globalDatabaseThunk: string): string => {
    // Local-first sync engine, global tier: when a project has shapes AND
    // `.global()` tables, the DO serves a `.global()`-table shape's seed/poll
    // rows by draining the global backend's `findMany` under the socket's
    // verified identity — the same identity-scoped read the poke-live path uses,
    // just against D1/Hyperdrive instead of this DO's op-log. Emitted only when
    // both features are present so a shape-free or global-free `shard.ts` stays
    // byte-identical.
    /* eslint-disable no-secrets/no-secrets -- the emitted override method body references dense generated identifiers (`withinGlobalShapeBound`, `ShardDOBase.GLOBAL_SHAPE_MAX_ROWS`), not credentials */
    const globalShapeReaderOverride = enabled
        ? `
        protected override async readGlobalShapeRows(resolved: { columns?: readonly string[]; effectiveWhere?: WhereInput; global?: boolean; table: string }, identity?: SubscriptionIdentity): Promise<Array<{ doc: Record<string, unknown>; id: string }>> {
            const env = this.env as Record<string, unknown>;
            // A shape read performs no writes, so the widened request only needs
            // the inbound bookmark (pin the membership drain to the caller's own
            // prior writes) — no \`onBookmark\` here.
            //
            // The two identity members are named rather than spread, matching the
            // dispatch-path request built in \`buildCtx\`. A spread would also hand
            // the global writer \`ip\`, and \`globalShapeReadKey\` — the per-flush
            // cache in front of this read — keys on identity + userId only. Equal
            // keys must mean equal rows, so a field the writer can scope by has to
            // be either in the key or out of the request; it is out.
            const globalRequest = { ...this.globalCdcOptions(config.cdc ?? false), bookmark: this.getInboundBookmark(), identity: identity?.identity, userId: identity?.userId };
            const globalDb: DatabaseWriterLike = ${globalDatabaseThunk}?.(env, globalRequest) ?? globalDbStub;
            const rows: Array<{ doc: Record<string, unknown>; id: string }> = [];

            let cursor: null | string = null;

            // Drain every page of the global membership so the seed/diff sees the
            // full rowset (D1 \`findMany\` is paginated). Stop one row past the cap:
            // a broad \`.global()\` shape would otherwise materialize an unbounded
            // array before the caller's \`withinGlobalShapeBound\` check rejects it,
            // so bail early and let the caller fail it closed.
            do {
                // eslint-disable-next-line no-await-in-loop -- sequential page drain to assemble the full membership
                const page = await globalDb.findMany(resolved.table, { cursor, where: resolved.effectiveWhere });

                for (const doc of page.page) {
                    rows.push({ doc, id: String((doc as { _id?: unknown })._id) });

                    if (rows.length > ShardDOBase.GLOBAL_SHAPE_MAX_ROWS) {
                        return rows;
                    }
                }

                cursor = page.isDone ? null : page.continueCursor;
            } while (cursor !== null);

            return rows;
        }

        protected override async readGlobalChangedTables(sinceSeq: number, cursorOnly?: boolean): Promise<{ cursor: number; floor?: number; tables: string[] } | undefined> {
            const env = this.env as Record<string, unknown>;
            // Metadata-only: this asks the global changelog which TABLES moved,
            // never what changed in them, so it costs one small read per poll tick
            // for the whole shard — and a tick whose answer omits a shape's table
            // skips that shape's membership drain entirely.
            // Named local, not an inline object literal — same reason as the
            // dispatch path and \`readGlobalShapeRows\`: \`bookmark\` is not declared
            // on the narrower Hyperdrive thunk's \`request\` type, and an inline
            // literal trips an excess-property error (TS2353) that makes the
            // emitted \`shard.ts\` uncompilable for every Hyperdrive-global app with
            // a \`defineShape\`. The Hyperdrive factory simply never reads it.
            const globalRequest = { ...this.globalCdcOptions(config.cdc ?? false), bookmark: this.getInboundBookmark() };
            const globalDb: DatabaseWriterLike = ${globalDatabaseThunk}?.(env, globalRequest) ?? globalDbStub;

            return globalDb.cdcChangedTables?.(sinceSeq, { cursorOnly });
        }
`
        : "";
    /* eslint-enable no-secrets/no-secrets */

    return globalShapeReaderOverride;
};

export { emitGlobalShapeReaderOverride, emitShapeFragments };
