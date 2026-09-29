/**
 * The emitted ShardDO's admin/maintenance write methods (data migrations, studio
 * row writes, export/import, rank/relation pages, CDC apply) and the bare writer
 * they all go through. Static — split out of `emitShard`.
 */

/**
 * The single generated builder for the bare admin/maintenance ctx-db writer —
 * no RLS, no read hooks, just broadcast + CDC over this instance's SQLite.
 *
 * Emitted ONCE per shard class and called by all seven admin entry points
 * (migrations, shard writes, imports, exports, ranks). Inlining it at each
 * call site put seven copies of this block — and seven copies of its comments
 * — into every user's `_generated/shard.ts`, which was ~15% of the file.
 */
const adminWriterMethod = `        /**
         * The bare writer every admin/maintenance entry point writes through.
         *
         * Admin and maintenance writes go through the SAME reactive-cache hooks as a
         * user mutation. Without this, a studio row edit, a TTL sweep, an admin
         * import, a CDC apply or a data-migration backfill writes without
         * invalidating, and the next query answers from the pre-write snapshot.
         *
         * \`headroom\` meters the transaction. An admin \`/rpc\` caller passes nothing
         * and falls back to \`this.transactionHeadroom()\`, which for an admin RPC is
         * \`undefined\` — \`handleAdminRpc\` answers before \`beginDispatch\`, so no
         * per-dispatch meter is in flight and a bulk loop is bounded by its per-call
         * row cap alone. The TTL sweep (an alarm work item, no dispatch) passes its
         * own by-value tracker explicitly instead.
         */
        private adminWriter(headroom?: TransactionHeadroomTracker): DatabaseWriterLike {
            const env = (this.env ?? {}) as Record<string, unknown>;
            const scheduler = (config.scheduler?.(env) ?? schedulerStub) as SchedulerLike;

            return createShardCtxDb({
                ...this.ctxDbTuning(),
                broadcast: (delta) => {
                    this.recordChangedTable(delta.table, delta.indexKeys);
                },
                cdc: config.cdc ?? false,
                headroom,
                // Live predicate, same as the user-facing ctx — see \`databaseOptions\`.
                inTransaction: () => this.isInTransaction(),
                scheduler,
                schema: schema as unknown as SchemaLike,
                sql: this.sql as SqlExec,
            });
        }`;

/** Call the generated {@link adminWriterMethod}; only `runShardWrite` needs a meter. */
const adminWriterPrelude = (headroomExpression = ""): string => `            const writer = this.adminWriter(${headroomExpression});`;

/* eslint-disable no-secrets/no-secrets -- emitted ShardDO source, not credentials */
const ADMIN_WRITE_METHODS: string = `${adminWriterMethod}

        protected override async runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
            this.ensureMigrated();

            // Falls back to the framework's reserved re-projection backfill
            // (\`__lunora_reproject__<table>\`), which rewrites rows whose
            // v.bigint()/v.bytes() columns are still stored in the pre-projection
            // tagged form. Built here rather than at module scope because it
            // needs this shard's \`sql\` handle to tell a legacy row from a
            // current one.
            const migration = LUNORA_MIGRATIONS[args.id] ?? buildReprojectionMigration(args.id, schema as unknown as SchemaLike, this.sql as SqlExec);

            if (!migration) {
                throw new LunoraError("MIGRATION_NOT_FOUND", \`data migration "\${args.id}" is not registered\`, { status: 404 });
            }

${adminWriterPrelude()}

            return runDataMigration({
                batchSize: args.batchSize,
                direction: args.direction,
                dryRun: args.dryRun,
                maxBatches: args.maxBatches,
                migration: migration as unknown as DataMigrationLike,
                // Flush after each batch so live migrationStatus subscribers see
                // progress mid-run (the base method records the reserved state
                // table the raw-SQL progress write is invisible to the tracker).
                onBatch: () => this.flushMigrationProgress(),
                sql: this.sql as SqlExec,
                writer,
            });
        }

        protected override async runShardWrite(args: RunShardWriteArgs, headroom?: TransactionHeadroomTracker): Promise<RunShardWriteResult> {
            const definition = (schema as unknown as SchemaLike).tables[args.table];

            if (!definition) {
                throw new LunoraError("UNKNOWN_TABLE", \`unknown table: \${args.table}\`, { status: 404 });
            }

            // \`.global()\` tables live in D1, not this DO's SQLite — editing them
            // here would corrupt nothing but would fail confusingly, so reject up
            // front with a clear code the studio can surface.
            if (definition.shardMode?.kind === "global") {
                throw new LunoraError("GLOBAL_TABLE_NOT_EDITABLE", \`table "\${args.table}" is global; edit it through D1, not the shard\`, { status: 400 });
            }

            this.ensureMigrated();

${adminWriterPrelude("headroom ?? this.transactionHeadroom()")}

            if (args.op === "insert") {
                const id = await writer.insert(args.table, args.doc ?? {});

                return { id, op: "insert" };
            }

            // Every by-id op PINS \`args.table\`. Unpinned, \`locateRowById\` probes
            // every non-global table for the id, so a request naming table A with an
            // id belonging to table B locates and mutates B's row — the by-id IDOR
            // the per-table \`ctx.db.<table>\` facade pins against. Pinning also stops
            // an absent row falling through to the \`.global()\` D1 twin, though that
            // branch is already unreachable here: \`adminWriter\` is built without a
            // \`globalDb\`, so a miss throws \`NOT_FOUND\` either way.
            // \`hard\` is set only by the BULK delete arm, which needs the row gone
            // from the physical table for its next batch's scan to make progress.
            // A single-row \`writeRow\` delete never carries it, so it keeps the
            // table's declared \`.softDelete()\` behaviour.
            if (args.op === "delete") {
                await writer.delete(args.id ?? "", args.table, { hard: args.hard === true });

                return { id: args.id ?? null, op: "delete" };
            }

            if (args.op === "replace") {
                await writer.replace(args.id ?? "", args.doc ?? {}, args.table);

                return { id: args.id ?? null, op: "replace" };
            }

            await writer.patch(args.id ?? "", args.doc ?? {}, args.table);

            return { id: args.id ?? null, op: "patch" };
        }

        // The base \`ShardDO\` cannot build a schema-aware writer, so its
        // \`runShardExport\`/\`runShardImport\` return \`[]\` and \`{inserted:{}}\`.
        // Those are success-shaped: an empty export is what a correct export of
        // an empty shard looks like, so a backup of a populated sharded schema
        // reported success and wrote nothing, and an import reported success and
        // dropped every row. Overriding both here is what makes the two admin
        // RPCs real for a \`.shardBy()\` table.
        //
        // NOTE: the admin export RPC is not paginated — \`parseExportShardArgs\`
        // takes \`tables\`/\`batchSize\` but no cursor, and the coordinator issues
        // one call per shard — so the rows are collected into a single response.
        // \`batchSize\` bounds the SQLite scan page, not the reply. A shard holding
        // more rows than fit in the DO's memory budget will therefore fail the
        // export rather than stream it. That is a loud failure where the bug this
        // replaces was a silent empty one, but a cursor on the RPC is what makes
        // this a complete backup path for large shards.
        protected override async runShardExport(args: RunShardExportArgs): Promise<ExportRow[]> {
            this.ensureMigrated();

${adminWriterPrelude()}

            const rows: ExportRow[] = [];

            // \`exportShardRows\` walks in keyset batches so a large table does not
            // materialize at once inside the generator; the admin RPC's response
            // is a single array, so it is collected here rather than streamed.
            for await (const row of exportShardRows(writer, schema as unknown as SchemaLike, { batchSize: args.batchSize, tables: args.tables })) {
                rows.push(row);
            }

            return rows;
        }

        protected override async runShardImport(args: RunShardImportArgs): Promise<ImportShardResult> {
            this.ensureMigrated();

${adminWriterPrelude()}

            // \`importShardRows\` inserts with \`allowExplicitId\`, so a source
            // database's \`_id\`s carry across verbatim and every foreign key
            // referencing them stays valid without a second remapping pass.
            return importShardRows(writer, schema as unknown as SchemaLike, { rows: args.rows, startLine: args.startLine });
        }

        protected override async runShardRankBefore(args: RunShardRankBeforeArgs): Promise<{ before: number; total: number }> {
            this.ensureMigrated();

${adminWriterPrelude()}

            // \`rankBefore\` is optional on \`DatabaseWriterLike\` (the D1 twin omits it),
            // but the shard writer from \`createShardCtxDb\` always defines it.
            if (!writer.rankBefore) {
                throw new LunoraError("NOT_IMPLEMENTED", "rankBefore is unavailable on the shard writer", { status: 500 });
            }

            return writer.rankBefore(args.table, args.index, {
                partitionKey: args.partitionKey,
                rowId: args.rowId,
                sortValues: args.sortValues,
            });
        }

        protected override async runShardFindRelated(args: RunShardFindRelatedArgs): Promise<RelatedPage> {
            this.ensureMigrated();

${adminWriterPrelude()}

            // \`related\` is optional on \`DatabaseWriterLike\` (the D1 twin omits it),
            // but the shard writer from \`createShardCtxDb\` always defines it — it
            // derives the edge set from this app's schema.
            if (!writer.related) {
                throw new LunoraError("NOT_IMPLEMENTED", "findRelated is unavailable on the shard writer", { status: 500 });
            }

            return writer.related(
                { id: args.id, table: args.table },
                { cursor: args.cursor, depth: args.depth, direction: args.direction, edges: args.edges, limit: args.limit },
            );
        }

        protected override async runShardRankPage(args: RunShardRankPageArgs): Promise<ShardRankPageResult> {
            this.ensureMigrated();

${adminWriterPrelude()}

            // \`rankPageRows\` is optional on \`DatabaseWriterLike\` (the D1 twin omits it),
            // but the shard writer from \`createShardCtxDb\` always defines it. The sort
            // directions live in the schema's rankIndex, so the shard reads them itself;
            // \`args.directions\` is only the coordinator's comparator hint and isn't forwarded.
            if (!writer.rankPageRows) {
                throw new LunoraError("NOT_IMPLEMENTED", "rankPage is unavailable on the shard writer", { status: 500 });
            }

            return writer.rankPageRows(args.table, args.index, {
                after: args.after,
                cursor: args.cursor,
                partitionKey: args.partitionKey,
                take: args.take,
            });
        }

        protected override async runShardApplyCdc(args: RunShardApplyCdcArgs): Promise<{ applied: number }> {
            this.ensureMigrated();

${adminWriterPrelude()}

            await applyCdcChanges(writer, args.changes);

            return { applied: args.changes.length };
        }`;
/* eslint-enable no-secrets/no-secrets */

export default ADMIN_WRITE_METHODS;
