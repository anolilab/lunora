import type { AdvisorProcedureProtection, Finding } from "@lunora/advisor";
import { LunoraError } from "@lunora/errors";
import type { AdvisorProcedure, AdvisoryFinding, MaskPoliciesResult, RlsPoliciesResult, StorageRulesResult, StudioFeaturesResult } from "@lunora/shard-engine";

import type { SchemaSnapshot } from "../../../../shared/schema-snapshot";
import { hashSchemaSnapshot, serializeSchemaSnapshot } from "../../../../shared/schema-snapshot";
import { isD1GlobalTable, isHyperdriveGlobalTable } from "../global-backend";
import type {
    AgentIR,
    ContainerIR,
    EnvIR,
    MaskMetadataIR,
    MutatorIR,
    QueueIR,
    RlsMetadataIR,
    SchemaIR,
    ShapeIR,
    StorageRulesMetadataIR,
    WorkflowIR,
} from "../ir";
import renderJsonData from "../json-data";
import ADMIN_WRITE_METHODS from "./shard-admin";
import {
    emitAccessFragments,
    emitAiFragments,
    emitAnalyticsFragments,
    emitBrowserFragments,
    emitEnvFragments,
    emitFlagsFragments,
    emitFlagsOverrides,
    emitHyperdriveFragments,
    emitImagesFragments,
    emitKvFragments,
    emitNotifyFragments,
    emitPipelinesFragments,
    emitR2sqlFragments,
    emitRelationFanout,
    renderThrowingStub,
} from "./shard-bindings";
import renderBuildContext from "./shard-context";
import { DISPATCH_METHODS, DISPATCH_RUN_SOURCE, SUBSCRIPTION_METHODS } from "./shard-dispatch";
import { buildStorageColumns, buildTableColumns, buildTableIndexes, buildTableReferences, buildTtlSweeps } from "./shard-metadata";
import {
    buildDoTypeImports,
    emitAgentFragments,
    emitContainerFragments,
    emitPaymentFragments,
    emitQueueFragments,
    emitQueuesMetadataFragments,
    emitWorkflowFragments,
    emitWorkflowsMetadataFragments,
    emitX402Fragments,
} from "./shard-runtime";
import { emitGlobalShapeReaderOverride, emitShapeFragments } from "./shard-shapes";
import emitExternalSourceFragments from "./shard-sources";
import emitVectorFragments from "./shard-vectors";
import { baseSpecifiers, GENERATED_HEADER } from "./shared";

interface EmitShardOptions {
    advisories?: ReadonlyArray<Finding>;
    /** Every declared procedure — the health map's denominator, served via `getAdvisorProcedures`. */
    advisorProcedures?: ReadonlyArray<AdvisorProcedureProtection>;
    /** Agents declared via `defineAgent` exports in `lunora/agents.ts` — wires the typed `ctx.agents` producers. */
    agents?: ReadonlyArray<AgentIR>;
    containers?: ReadonlyArray<ContainerIR>;
    /** The single `defineEnv(...)` contract declared in `lunora/env.ts` — applies the accessor to the worker `env` to populate `ctx.env`. */
    env?: EnvIR;
    /** Statically-discovered `ctx.flags.<type>("key")` reads — the studio Flags page + reactive evaluation iterate these. */
    flagKeys?: ReadonlyArray<{ key: string; type: "boolean" | "number" | "object" | "string" }>;
    /** A `lunora/` source reads `ctx.access` — wires the verified Cloudflare Access facade onto every ctx. */
    hasAccessFacade?: boolean;
    hasAi?: boolean;
    /** A `lunora/` source reads `ctx.analytics` — wires the Analytics Engine write helper onto every ctx. */
    hasAnalytics?: boolean;
    /** A `lunora/` source reads `ctx.browser` — wires `ctx.browser` onto the ActionCtx only. */
    hasBrowser?: boolean;
    /** The project declares `lunora/flags.ts` — wires `ctx.flags` (OpenFeature) onto every ctx. */
    hasFlags?: boolean;
    /** A `lunora/` source reads `ctx.sql` (Hyperdrive) — wires `ctx.sql` onto the ActionCtx only. */
    hasHyperdrive?: boolean;
    /** A `lunora/` source reads `ctx.images` — wires `ctx.images` onto the ActionCtx only. */
    hasImages?: boolean;
    /** A `lunora/` source reads `ctx.kv` — wires `ctx.kv` onto every ctx. */
    hasKv?: boolean;
    /** The project declares `lunora/notify.ts` — wires `ctx.notify` + its `ctx.push` alias (`@lunora/notify`) onto every ctx. */
    hasNotify?: boolean;
    hasPayments?: boolean;
    /** A `lunora/` source reads `ctx.pipelines` — wires `ctx.pipelines` onto the ActionCtx only. */
    hasPipelines?: boolean;
    /** A `lunora/` source reads `ctx.r2sql` (R2 SQL) — wires `ctx.r2sql` onto the ActionCtx only. */
    hasR2sql?: boolean;

    /**
     * The target platform supports a vector store. `false` withholds the whole
     * Vectorize wiring — the `@lunora/bindings/vectors` imports, the
     * `createVectorSyncHook` write hook and `vectors` on the runtime ctx — even
     * when the schema declares an index, mirroring what `emitServer` and
     * `emitApp` withhold from the type surface for the same verdict.
     */
    hasVectors?: boolean;
    /** A `lunora/` source reads `ctx.x402` — wires the agent-wallet pay rail onto the ActionCtx only. */
    hasX402?: boolean;
    maskMetadata?: MaskMetadataIR;
    /** Custom mutators declared via `defineMutator` in `lunora/mutators.ts` — wires the `isCustomMutator` push-protocol override. */
    mutators?: ReadonlyArray<MutatorIR>;
    /** Queues declared via `defineQueue` exports in `lunora/queues.ts` — wires the typed `ctx.queues` producers. */
    queues?: ReadonlyArray<QueueIR>;
    rlsMetadata?: RlsMetadataIR;
    schema: SchemaIR;

    /**
     * The structural snapshot the pre-deploy drift gate diffs against, threaded
     * in so the emitted DO records it in `__lunora_schema_history` on cold start
     * (plan 200 — the Studio's schema-version timeline). Optional so an emitter
     * caller that has no snapshot (tests, fixtures) emits the pre-ledger shape
     * unchanged.
     */
    schemaSnapshot?: SchemaSnapshot;
    /** Replication shapes declared via `defineShape` in `lunora/shapes.ts` — wires the `resolveShape` subscription override. */
    shapes?: ReadonlyArray<ShapeIR>;
    storageRules?: StorageRulesMetadataIR;
    studioFeatures?: StudioFeaturesResult;
    /** The project depends on the `lunora` umbrella — import base packages via its subpaths. */
    useUmbrella?: boolean;
    workflows?: ReadonlyArray<WorkflowIR>;
}

/* eslint-disable sonarjs/cognitive-complexity -- emitter that gates each Cloudflare-capability fragment behind its own `has*`/length flag to assemble dense generated TS; the branching is the per-binding emission contract, not refactorable logic */
const emitShard = ({
    advisories = [],
    advisorProcedures = [],
    agents = [],
    containers = [],
    env,
    flagKeys = [],
    hasAccessFacade = false,
    hasAi = false,
    hasAnalytics = false,
    hasBrowser = false,
    hasFlags = false,
    hasHyperdrive = false,
    hasImages = false,
    hasKv = false,
    hasNotify = false,
    hasPayments = false,
    hasPipelines = false,
    hasR2sql = false,
    hasVectors = true,
    hasX402 = false,
    maskMetadata,
    mutators = [],
    queues = [],
    rlsMetadata,
    schema,
    schemaSnapshot,
    shapes = [],
    storageRules,
    studioFeatures,
    useUmbrella = false,
    workflows = [],
}: EmitShardOptions): string => {
    const base = baseSpecifiers(useUmbrella);
    const hasMutators = mutators.length > 0;
    const hasShapes = shapes.length > 0;
    // The schema-version ledger (plan 200). The snapshot the drift gate diffs is
    // embedded verbatim so the DO can append it to `__lunora_schema_history` on
    // cold start, keyed by its content hash — reverting a schema re-links to the
    // existing row instead of appending a duplicate. Embedding costs a few KB of
    // bundle for a typical schema; recomputing it in the DO instead would need a
    // SECOND snapshot builder over the runtime `SchemaLike`, and two builders
    // would eventually disagree with the gate. Omitted entirely when no snapshot
    // is supplied, so the generated output is byte-identical to before.
    const schemaSnapshotJson = schemaSnapshot === undefined ? "" : serializeSchemaSnapshot(schemaSnapshot);
    const schemaSnapshotConst =
        schemaSnapshot === undefined
            ? ""
            : `
/** Structural schema snapshot + its content hash, recorded in the shard's \`__lunora_schema_history\` ledger on cold start so the studio can show a schema-version timeline and diff any two versions. */
const LUNORA_SCHEMA_SNAPSHOT: { hash: string; json: string } = { hash: ${JSON.stringify(hashSchemaSnapshot(schemaSnapshot))}, json: ${JSON.stringify(schemaSnapshotJson)} };
`;
    const snapshotArgument = schemaSnapshot === undefined ? "" : ", schemaSnapshot: LUNORA_SCHEMA_SNAPSHOT";
    const { build: aiBuild, configField: aiConfigField, stub: aiStub } = emitAiFragments(hasAi);
    // New Cloudflare-capability helpers, mirroring `emitAiFragments`. `kv` /
    // `analytics` ride EVERY ctx (deterministic-read / fire-and-forget-write);
    // `images` / `sql` / `browser` are ActionCtx-only (external, non-deterministic
    // I/O) and are woven onto the action ctx object only — see the `isAction` gate.
    const accessFragments = emitAccessFragments(hasAccessFacade);
    const kvFragments = emitKvFragments(hasKv);
    const flagsFragments = emitFlagsFragments(hasFlags, base.flags);
    const flagsOverrides = emitFlagsOverrides(flagKeys, hasFlags, base.flags);
    const notifyFragments = emitNotifyFragments(hasNotify);
    const envFragments = emitEnvFragments(env);
    const analyticsFragments = emitAnalyticsFragments(hasAnalytics);
    const imagesFragments = emitImagesFragments(hasImages);
    const hyperdriveFragments = emitHyperdriveFragments(hasHyperdrive);
    const browserFragments = emitBrowserFragments(hasBrowser);
    const r2sqlFragments = emitR2sqlFragments(hasR2sql);
    const pipelinesFragments = emitPipelinesFragments(hasPipelines);
    const { build: queuesBuild, contextField: queuesContextField, importLines: queueImportLines, specs: queueSpecs } = emitQueueFragments(queues);
    const {
        build: containersBuild,
        contextField: containersContextField,
        importLines: containerImportLines,
        specs: containerSpecs,
    } = emitContainerFragments(containers, schema.jurisdiction);
    const {
        build: workflowsBuild,
        contextField: workflowsContextField,
        importLines: workflowImportLines,
        specs: workflowSpecs,
    } = emitWorkflowFragments(workflows);
    const { build: agentsBuild, contextField: agentsContextField, importLines: agentImportLines, specs: agentSpecs } = emitAgentFragments(agents);
    const {
        build: paymentsBuild,
        configField: paymentsConfigField,
        contextField: paymentsContextField,
        imports: paymentsImports,
        stub: paymentStub,
    } = emitPaymentFragments(hasPayments);
    // `ctx.x402` is ActionCtx-only and money-spending, so — like `ctx.sql` /
    // `ctx.browser` / `ctx.images` — it is built AND attached only inside the
    // `if (isAction)` block below (it exposes no `contextField`: a query/mutation
    // ctx never carries the property at runtime, not just in types).
    const { build: x402Build, configField: x402ConfigField, imports: x402Imports, stub: x402Stub } = emitX402Fragments(hasX402);
    // Drift guard + the data we emit: the advisor's `Finding`s must stay
    // assignable to the DO's `AdvisoryFinding` (the generated `LUNORA_ADVISORIES`
    // is typed against it). This assignment fails `tsc` if the two shapes drift —
    // `@lunora/do` hand-mirrors `Finding` to avoid depending on `@lunora/advisor`.
    const advisoryData: ReadonlyArray<AdvisoryFinding> = advisories;
    // Typed as the DO's shape on purpose: the generated file declares
    // `LUNORA_ADVISOR_PROCEDURES: AdvisorProcedure[]`, so without this assignment
    // a field added to the advisor's type and forgotten in `@lunora/do` compiles
    // here and breaks in the *user's* tsc. Mirrors the `AdvisoryFinding` guard above.
    const advisorProcedureData: ReadonlyArray<AdvisorProcedure> = advisorProcedures;

    // Same drift guard for the RLS inspector's metadata: codegen's `RlsMetadataIR`
    // must stay assignable to the DO's `RlsPoliciesResult` (the generated
    // `LUNORA_RLS_METADATA` is typed against it and fed straight to the
    // `rlsMetadata()` override). `@lunora/do` hand-mirrors the shape to avoid
    // depending on `@lunora/codegen`.
    const rlsData: RlsPoliciesResult = rlsMetadata ?? { policies: [], roles: [] };
    // Same drift guard for the data-browser mask preview: codegen's
    // `MaskMetadataIR` must stay assignable to the DO's `MaskPoliciesResult` (the
    // generated `LUNORA_MASK_METADATA` is typed against it and fed straight to the
    // `maskMetadata()` override). `@lunora/do` hand-mirrors the shape to avoid
    // depending on `@lunora/codegen`.
    const maskData: MaskPoliciesResult = maskMetadata ?? { columns: [] };
    // Same drift guard for the storage access-rules view: codegen's
    // `StorageRulesMetadataIR` must stay assignable to the DO's
    // `StorageRulesResult` (the generated `LUNORA_STORAGE_RULES` is typed against
    // it and fed straight to the `storageRulesMetadata()` override).
    const storageRulesData: StorageRulesResult = storageRules ?? { rules: [] };
    // Which optional package-backed nav pages the studio should show, fed straight
    // to the generated `studioFeatures()` override. The default (all-false) hides
    // every optional page — matching the un-generated base-class behaviour.
    const studioFeaturesData: StudioFeaturesResult = studioFeatures ?? {
        analytics: false,
        auth: false,
        containers: false,
        flags: false,
        kv: false,
        mail: false,
        notifications: false,
        payments: false,
        queues: false,
        scheduler: false,
        storage: false,
        vectors: false,
        workflows: false,
    };
    // Read-only declared-workflow metadata fragments for the studio's workflows
    // view (the `LUNORA_WORKFLOWS_INFO` constant + the `workflowsMetadata()`
    // override), both empty unless the project declares workflows.
    const { constant: workflowsMetadataConst, override: workflowsMetadataOverride } = emitWorkflowsMetadataFragments(workflows);
    const { constant: queuesMetadataConst, override: queuesMetadataOverride } = emitQueuesMetadataFragments(queues);
    // The platform gate's verdict AND the app's declaration — the same pairing
    // `emitServer` makes, and it has to be made here too: this emitter used to
    // recompute the flag from the raw schema, so a target rating `vectorStore`
    // as `unsupported` got a `shard.ts` byte-identical to the Cloudflare one
    // (imports, write hook, runtime ctx field and all) while `server.ts` and
    // `app.ts` correctly withheld theirs. Defaults to `true` so an emitter
    // caller that does not gate (tests, fixtures) is unchanged.
    const hasVectorIndexes = hasVectors && schema.vectorIndexes.length > 0;
    // Cross-tenant leak guard: Vectorize indexes are account-global, so a
    // vector index owned by a `.shardBy()`'d table must scope its auto-sync
    // upserts by the owning DO's shard key, or every tenant's vectors land in
    // one shared namespace. A vectorized table that stays `root`/`global` has
    // exactly one canonical copy — no shard key to scope by — so this must
    // stay `false` for those, keeping their emitted `shard.ts` (and goldens)
    // byte-identical to the namespace-less form.
    //
    // Gated on `schema.vectorIndexes` (not `table.vectorIndexes`) because only
    // inline `.vectorize()` (Shape A) indexes get hoisted onto their owning
    // `TableIR.vectorIndexes`; standalone `defineVectorIndex(...)` (Shape B —
    // the `defineSchema` 2nd-arg map, and extension-contributed ones) live
    // only in the schema-level `vectorIndexes` array, keyed back to their
    // owner via `VectorIndexIR.table`. Checking `table.vectorIndexes.length`
    // alone misses those and leaves a sharded Shape-B index syncing into one
    // unpartitioned namespace — the same cross-tenant leak this guard exists
    // to close.
    // `TableIR["shardMode"]` has exactly one object-typed member today, so
    // `.kind === "shardBy"` below is a no-op under the current type — kept
    // explicit (over bare `typeof === "object"`) so this still discriminates
    // correctly if the union ever grows a second object-shaped shard mode.
    const shardedTableNames = new Set(
        schema.tables
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see comment above
            .filter((table) => typeof table.shardMode === "object" && table.shardMode.kind === "shardBy")
            .map((table) => table.name),
    );
    // `hasVectorIndexes &&`, not the raw scan: this also gates the `ROOT_SHARD_NAME`
    // import, which would otherwise be emitted (and unused) on a target whose
    // matrix withholds the vector wiring the sentinel is only read by.
    const hasShardedVectors = hasVectorIndexes && schema.vectorIndexes.some((index) => shardedTableNames.has(index.table));
    const hasGlobalTables = schema.tables.some((table) => table.shardMode === "global");
    // Which `.global()` backend(s) the schema uses. A `.global()` table defaults
    // to D1; `.global({ backend: "hyperdrive" })` routes it to a Postgres/MySQL
    // database via Hyperdrive. Both stay reactive — the writer is injected as
    // `globalDb` and the broadcast hook drives live queries.
    const hasHyperdriveGlobal = schema.tables.some((table) => isHyperdriveGlobalTable(table));
    const hasD1Global = schema.tables.some((table) => isD1GlobalTable(table));
    // External-source ingest (plan 077): `.source(...)` tables are materialized from
    // Hyperdrive into this DO's SQLite by the poll alarm. Everything below is gated on
    // this, so a schema with no sourced table emits a byte-identical `shard.ts`.
    const hasSourcedTables = schema.tables.some((table) => table.externalSource !== undefined);
    const hasMemoryTables = schema.tables.some((table) => table.memory === true);
    // Shard-local search indexes are what the `__lunora_admin__:backfillSearch`
    // override serves; a schema with none leaves the base class's "unsupported"
    // hook in place rather than emitting a call that can only report zero pages.
    const hasShardSearchIndexes = schema.tables.some((table) => table.shardMode !== "global" && table.searchIndexes.length > 0);

    if (hasD1Global && hasHyperdriveGlobal) {
        // Mixing backends needs a per-table routing writer (id-addressed ops must
        // probe both stores) — not supported yet. Pick one backend per app.
        throw new LunoraError(
            "INTERNAL",
            'lunora codegen: mixing `.global()` (D1) and `.global({ backend: "hyperdrive" })` tables in one app is not supported yet — use a single global backend.',
        );
    }

    const hasTables = schema.tables.length > 0;
    const tableReferences = buildTableReferences(schema);
    const tableIndexes = buildTableIndexes(schema);
    const tableColumns = buildTableColumns(schema);
    const storageColumns = buildStorageColumns(schema);
    const ttlSweeps = buildTtlSweeps(schema);

    // The facade option types (AggregateOptions/QueryArgs/RestrictableQueryOptions/
    // SearchFilterBuilderLike/…) are no longer imported here — `bindTableFacade`
    // (from `@lunora/server`) now owns the per-table accessor binding.
    const doTypeImports = buildDoTypeImports(hasVectorIndexes, workflows.length > 0, queues.length > 0, hasFlags, hasShardSearchIndexes);

    // A shape's `resolveShape` override returns an `effectiveWhere: WhereInput`,
    // so the DO's `WhereInput` type is pulled in only when the project has shapes.
    if (hasShapes) {
        doTypeImports.push("WhereInput");
    }

    // Reverse cross-backend relation override + its `@lunora/do` import fragment
    // (both empty unless the project has `.global()` tables). See `emitRelationFanout`.
    const relationFanout = emitRelationFanout(hasGlobalTables);

    const { customMutatorOverride, shapeGuardImport, shapeReadPolicyAssertion, shapeReadPolicyImport, shapeResolveOverride } = emitShapeFragments({
        hasMutators,
        hasShapes,
        rlsData,
    });

    const importLines = [
        `import type { ${doTypeImports.join(", ")} } from "${base.do}";`,
        `import { applyCdcChanges, ${hasShardSearchIndexes ? "backfillSearchIndexes, " : ""}${hasVectorIndexes ? "backfillVectorIndexes, " : ""}buildReprojectionMigration, ${hasMemoryTables ? "clearMemoryTables, " : ""}${shapeGuardImport}createReadFootprint, createShardCtxDb, exportShardRows, importShardRows, ${hasSourcedTables ? "isSourceDue, pullExternalSourceIncrementalTick, pullExternalSourceTick, " : ""}markUnvouchableReads, ${hasShardedVectors ? "ROOT_SHARD_NAME, " : ""}runDataMigration, runShardMigrations, ${relationFanout.importFragment}ShardDO as ShardDOBase } from "${base.do}";`,
        // `TraceRefLike` rides along with the source imports: the poll override
        // takes the alarm's trace so its contained failures are correlated, and
        // `@lunora/do` projects it structurally rather than re-exporting the
        // observability type.
        ...(hasSourcedTables ? [`import type { ExternalSourceLike, SourceClientLike, TraceRefLike } from "${base.do}";`] : []),
        // `asBucketStorage` (the bucket-aware `ctx.storage` wrapper) and
        // `createSecrets` (the `ctx.secrets` core built-in) live in
        // `@lunora/server`, the single source — imported here rather than stamped
        // inline into every generated shard. With shapes, also pull the RLS
        // read-registry builder + `composeShapeReadWhere` so `resolveShape` can
        // AND-merge a shape's predicate with the table's read base-where.
        hasShapes
            ? `import { asBucketStorage, ${shapeReadPolicyImport}beginDeferredDeletes, beginDeferredSchedules, composeShapeReadWhere, createSecrets, flushDeferredDeletes, LunoraError, withDeferredDeletes, withDeferredSchedules } from "${base.server}";`
            : `import { asBucketStorage, beginDeferredDeletes, beginDeferredSchedules, createSecrets, flushDeferredDeletes, LunoraError, withDeferredDeletes, withDeferredSchedules } from "${base.server}";`,
    ];

    // The per-table facade binding lives in `@lunora/server` so codegen and the
    // RLS middleware share one implementation (no drift). Only needed when the
    // project declares tables (otherwise no facade is built).
    if (hasTables) {
        importLines.push(`import { bindOrm, bindTableFacade } from "${base.server}";`);
    }

    if (hasVectorIndexes) {
        importLines.push(
            `import type { SchemaLike as VectorSchemaLike, VectorBackfillSync, VectorizeIndexLike, VectorSearchLike } from "@lunora/bindings/vectors";`,
            `import { createContextVectors, createVectorBackfillSync, createVectors, createVectorSyncHook, vectorBackfillTargets } from "@lunora/bindings/vectors";`,
        );
    }

    if (hasAi) {
        importLines.push(`import type { AiBindingLike, LunoraAi } from "@lunora/ai";`, `import { createAi } from "@lunora/ai";`);
    }

    importLines.push(
        ...accessFragments.importLines,
        ...kvFragments.importLines,
        ...flagsFragments.importLines,
        ...notifyFragments.importLines,
        ...envFragments.importLines,
        ...analyticsFragments.importLines,
        ...imagesFragments.importLines,
        ...hyperdriveFragments.importLines,
        ...browserFragments.importLines,
        ...r2sqlFragments.importLines,
        ...pipelinesFragments.importLines,
        ...containerImportLines,
        ...workflowImportLines,
        ...queueImportLines,
        ...agentImportLines,
        ...paymentsImports,
        ...x402Imports,
        ``,
        `import schema from "../schema.js";`,
        // Local-first sync registries are pulled in alongside the function table
        // only when the project declares them, so the import list stays minimal.
        `import { ${["LUNORA_FUNCTIONS", "LUNORA_LIFECYCLE_HOOKS", "LUNORA_MIGRATIONS", ...(hasMutators ? ["LUNORA_MUTATOR_PATHS"] : []), ...(hasShapes ? ["LUNORA_SHAPES"] : [])].join(", ")} } from "./functions.js";`,
    );

    const vectorsConfigField = hasVectorIndexes ? `\n    vectors?: (env: Record<string, unknown>) => Record<string, VectorizeIndexLike>;` : "";

    // `.global()` tables live in D1, not the DO's SQLite. The runtime D1 binding
    // arrives via an optional `d1` config thunk; when omitted (or for projects
    // with no global tables), reads/writes to a global table hit `globalDbStub`
    // and throw a descriptive error.
    // `bookmark`/`onBookmark` are declared here, not just passed: the DO hands
    // every D1 thunk the widened `globalRequest` so a factory can pin reads to the
    // caller's prior writes (D1 Sessions) and report the bookmark a write produced.
    // Undeclared, a direct `createShardDO({ d1 })` integration cannot read either
    // field under `noImplicitAny`. The Hyperdrive thunk below stays narrow on
    // purpose — it is handed the same object and simply never reads the extras.
    const d1ConfigField = hasD1Global
        ? `\n    d1?: (env: Record<string, unknown>, request?: { bookmark?: string; cdc?: boolean; cdcRetentionMs?: number; identity?: Record<string, unknown>; onBookmark?: (bookmark: string | undefined) => void; userId?: string }) => DatabaseWriterLike | undefined;`
        : "";

    // Hyperdrive-backed `.global()` tables receive their writer via an optional
    // `hyperdriveGlobal` thunk (mirrors `d1`); the host builds it with the global
    // writer factory from `@lunora/hyperdrive/global` over a Hyperdrive driver.
    const hyperdriveGlobalConfigField = hasHyperdriveGlobal
        ? `\n    hyperdriveGlobal?: (env: Record<string, unknown>, request?: { cdc?: boolean; cdcRetentionMs?: number; identity?: Record<string, unknown>; userId?: string }) => DatabaseWriterLike | undefined;`
        : "";

    // External-source ingest (plan 077): the host supplies one resolver that turns a
    // wrangler Hyperdrive binding into a SqlClient (build it with `@lunora/hyperdrive`'s
    // `createHyperdrive` + your driver adapter — the same one-liner as the docs recipe).
    // Called once per binding per DO lifetime (the poll loop memoizes it), so it need
    // not cache; identity-independent (it is just the tenant's connection).
    const sourceClientConfigField = hasSourcedTables
        ? `\n    sourceClient?: (env: Record<string, unknown>, binding: string) => { query: <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => Promise<Row[]> } | undefined;`
        : "";

    const globalDatabaseMissing = `throw new Error("ctx.db.<globalTable>: no global backend configured. Pass \`d1\` or \`hyperdriveGlobal\` to createShardDO().");`;
    const schedulerMissing = `throw new Error("ctx.scheduler: no scheduler configured. Pass \`scheduler\` to createShardDO().");`;
    const storageMissing = `throw new Error("ctx.storage: no storage configured. Pass \`storage\` to createShardDO().");`;
    const globalDatabaseStub = hasGlobalTables
        ? renderThrowingStub(
              "globalDbStub: DatabaseWriterLike",
              globalDatabaseMissing,
              [
                  "aggregate",
                  "count",
                  "delete",
                  "findFirst",
                  "findFirstOrThrow",
                  "findMany",
                  "get",
                  "groupBy",
                  "insert",
                  "normalizeId",
                  "patch",
                  "query",
                  "rank",
                  "rankPage",
                  "replace",
              ],
              { sync: ["normalizeId", "query"] },
          )
        : "";

    const { vectorSyncMethod, vectorsBuild, vectorsStub } = emitVectorFragments(
        hasVectorIndexes,
        hasShardedVectors ? schema.vectorIndexes.filter((index) => shardedTableNames.has(index.table)).map((index) => index.name) : [],
    );

    const globalDatabaseField = hasGlobalTables ? "\n                globalDb," : "";
    // Resolved request auth handed to `.serverDefault(fn)` column factories so
    // server-trusted columns (owner/tenant ids) stamp from the verified caller,
    // never the client. `userId`/`identity` are resolved above in `buildCtx`.
    const authField = "\n                auth: { identity: identity ?? null, userId: userId ?? null },";
    // `ctxDbTuning()` FIRST, so every per-request option below still wins. It
    // carries the reactive cache (row + index-range invalidation — without it a
    // write only invalidates table-wide) and the two relation knobs
    // (`maxRelationKeys` / `relationExistsPushDown`), which were unreachable in
    // every deployment while the RLS docs described `maxRelationKeys` as a cap
    // users could raise. Only keys the app set are present, so the spread never
    // clobbers an engine default with `undefined`.
    const databaseOptions = `{
                ...this.ctxDbTuning(),${authField}
                broadcast: (delta) => {
                    this.recordChangedTable(delta.table, delta.indexKeys);
                },
                // Read at call time, not captured: the baseline belongs to the
                // dispatch in flight, and a queued mutation admitted after a
                // sibling's prologue must be judged against ITS caller's cursor.
                baselineSeq: () => this.getCurrentBaselineSeq(),
                cdc: config.cdc ?? false,
                // A dispatch with NO caller identity runs system-trusted: RLS scopes
                // rows to a user, and these have no user to scope to. This is the tier
                // migrations, imports and the external-source poll loop already run in
                // (see \`adminWriterPrelude\`). Only \`onShardInit\` and \`onQueryChange\`
                // reach it; \`onConnect\`/\`onDisconnect\` carry a verified identity and
                // stay guarded like any request.
                enforceRls: options.trusted !== true,
                headroom: options.headroom ?? this.transactionHeadroom(),
                // A live predicate, not a flag: the transaction opens AFTER this ctx
                // is built (a mutation dispatch wraps the handler), so only a call-time
                // read reports the truth. \`_commitSeq\` reuses one sequence across
                // writes only while they commit together — an action is not wrapped, so
                // each of its writes allocates its own.
                inTransaction: () => this.isInTransaction(),
                onIndexUse: this.getCtxDbIndexUseHook(),
                onStalePatchDropped: (event) => {
                    this.recordStalePatchDropped(event);
                },
                // Bound to THIS dispatch's reactive-cache read scope (\`handleRpc\`
                // threads it in), so two concurrent queries never stamp each
                // other's dep sets. \`executeSubscription\` overrides both with its
                // own \`ReadFootprint\` pair instead, and a dispatch with neither
                // gets an unbound hook that stamps no deps.
                onRead: options.onRead ?? this.getCtxDbReadHook(options.scope),
                // Left \`undefined\` when there is no scope so \`createShardCtxDb\`
                // keeps its own "degrade a provable slice to a whole-table dep"
                // fallback rather than reporting into a no-op.
                onReadRange: options.onReadRange ?? (options.scope === undefined ? undefined : this.getCtxDbReadRangeHook(options.scope)),${
                    hasVectorIndexes
                        ? `
                // Vectorize is outside this shard's SQLite and cannot roll back, so
                // the sync is held until the mutation's transaction has COMMITTED
                // (\`deferAfterCommit\`) instead of running inline. Inline, a write
                // that later aborted left a vector pointing at a row that does not
                // exist — which a search then surfaces — and a rolled-back delete
                // left the row with its vector already purged. Outside a
                // transaction (an action) nothing is open and it runs at once.
                onWrite: onWrite === undefined ? undefined : (event) => this.deferAfterCommit(() => onWrite(event)),`
                        : ""
                }
                scheduler,
                schema: schema as unknown as SchemaLike,
                sql: this.sql as SqlExec,
                storage,${globalDatabaseField}
            }`;

    const vectorsContextField = hasVectorIndexes ? `\n                vectors,` : "";

    // `ctx.orm` mirrors the per-table facade under a kitcn-style namespace; it
    // only exists when the project declares tables (otherwise `facade` is unbuilt).
    const ormContextField = hasTables ? `\n                orm: bindOrm(facade),` : "";

    // Build `globalDb` only when a `.global()` table exists; otherwise the
    // binding (and the stub it falls back to) would be unused.
    // Declared BEFORE `db` so it can be passed into `createShardCtxDb({ globalDb })`:
    // the generic `ctx.db.insert("<global>", …)`/`query`/… methods route through
    // it to D1 (matching the property-style `ctx.db.<global>` facade below).
    // Pass the per-request identity into the \`d1\` factory so a cross-backend
    // reader it builds (reverse relations) can forward \`x-lunora-userid\` /
    // \`x-lunora-identity\` on the fan-out — each shard then applies its own
    // identity-scoped read. \`userId\`/\`identity\` are in scope from \`buildCtx\`.
    // Resolve `globalDb` from the active backend's thunk. A schema uses exactly
    // one global backend (mixed is rejected above), so this is a single writer —
    // D1 by default, or Hyperdrive when `.global({ backend: "hyperdrive" })`.
    const globalDatabaseThunk = hasHyperdriveGlobal ? "config.hyperdriveGlobal" : "config.d1";
    // Widen the per-request context handed to the global-database thunk with the
    // D1 Sessions API bookmark: `bookmark` lets a D1-backed factory pin reads to
    // the caller's own prior writes (read-your-writes across replicas), and
    // `onBookmark` lets it report back the bookmark a write produced so this DO
    // can record it on the dispatch's sink and echo it on the response.
    //
    // The bookmark lands in `options.bookmarks` — the DISPATCH's own sink,
    // value-threaded down from `handleRpc`, the way `headroom` and `scope` are.
    // It must not go on a shared field: a mutation is input-gated, but an ACTION
    // writes a global row and then `await`s a third party, and any sibling
    // dispatch running inside that window used to clear the field — so the action
    // answered with no `x-d1-bookmark` and the client's next global read went
    // unpinned. A non-`/rpc` caller (an alarm, a lifecycle dispatch) passes no
    // sink and the bookmark is dropped: there is no response to carry it.
    //
    // Assigned to a named local (not passed as an inline object literal) so
    // handing it to the narrower Hyperdrive thunk's `request` parameter type —
    // which does not declare these fields — doesn't trip an excess-property
    // error; the Hyperdrive factory simply never reads the extra properties.
    const globalDatabaseLine = hasGlobalTables
        ? `            const globalRequest = { ...this.globalCdcOptions(config.cdc ?? false), bookmark: this.getInboundBookmark(), identity, onBookmark: (bookmarkValue: string | undefined) => { if (options.bookmarks !== undefined) { options.bookmarks.value = bookmarkValue; } }, userId };\n            const globalDb: DatabaseWriterLike = ${globalDatabaseThunk}?.(env, globalRequest) ?? globalDbStub;\n`
        : "";

    const globalShapeReaderOverride = emitGlobalShapeReaderOverride(hasShapes && hasGlobalTables, globalDatabaseThunk);

    const { externalSourceOverride, sourceBootstrap, sourceClientCacheConst } = emitExternalSourceFragments(hasSourcedTables);

    // Once-per-instance init: empty every `.memory()` table, then fire the
    // `onShardInit` manifest. The base awaits this at every runtime entry point
    // (fetch / webSocketMessage / webSocketClose / alarm) before user code runs,
    // so a handler can never observe a memory table between the eviction that
    // emptied it and the hooks that refill it.
    //
    // Always emitted, even with no hooks and no memory tables: `dispatchShardInit`
    // iterates an empty manifest and costs nothing, and gating it at emit time
    // would mean a project that adds its first `onShardInit` to a shard generated
    // before this flag existed silently never fires it. The `clearMemoryTables`
    // call IS gated — it is only meaningful with a memory table, and leaving it out
    // keeps the import off shards that have none.
    //
    // `ensureMigrated()` runs first because the clear is a `DELETE FROM` and the
    // table has to exist: on a cold start this is the earliest code to touch SQL,
    // ahead of the dispatch that would normally have migrated.
    const shardInitOverride = `
        protected override async runShardInit(): Promise<void> {
            this.ensureMigrated();
${hasMemoryTables ? "            clearMemoryTables(this.sql as SqlExec, schema as unknown as SchemaLike);\n" : ""}
            await this.dispatchShardInit();
        }
`;

    // A single constructor bootstraps every alarm tier the schema needs: the
    // external-source ingest poll (auto-refresh sources) and the declarative TTL
    // sweep. Emitted only when at least one tier is present, so a plain schema
    // still gets a byte-identical `shard.ts`.
    const hasTtlTables = ttlSweeps.length > 0;
    const ttlBootstrap = hasTtlTables
        ? `
            if (LUNORA_TTL_SWEEPS.length > 0) {
                void this.scheduleTtlSweep();
            }
`
        : "";
    // The constructor is UNCONDITIONAL, and that is the fix: without it the
    // emitted subclass never called `super(state, env, options)`, so
    // `ShardDOOptions` was always `{}` and the per-shard reactive query cache
    // (plus the two relation knobs) was unreachable no matter what the app
    // configured. The alarm bootstraps ride the same constructor rather than
    // minting a second one.
    //
    // `isCacheableQuery` rides with it, and is equally load-bearing: the base
    // class has no function registry, so its answer is a conservative `false`
    // and `runCachedQuery` returns early on EVERY call — a wired cache that
    // memoizes nothing. This override is the single point where that goes
    // silently inert, which is why `emit-shard-reactive-cache.test.ts` pins it.
    // The generated `handleRpc` deliberately does NOT wrap dispatch in
    // `runCachedQuery` itself: the base `/rpc` path already routes through it,
    // and a second wrap would mint a SECOND read scope, so every read would land
    // in the inner tracker and the outer entry would be stored with zero deps —
    // permanently stale. `handleRpc` forwards the scope it is handed instead.
    /* eslint-disable no-secrets/no-secrets -- false positive: emitted generated-code text referencing the function registry, not a credential */
    const constructorOverride = `
        public constructor(state: ShardDOState, env: unknown) {
            super(state, env, {
                // Every writer this file builds spreads the ctxDbTuning() slice —
                // the user-facing ctx and all three admin/maintenance writers — so
                // the base class can drop its coarse invalidation backstop. Only the
                // emitter can know that; a hand-written subclass leaves this unset
                // and keeps the backstop.
                ctxDbCacheWired: true,
                ...(config.maxRelationKeys === undefined ? {} : { maxRelationKeys: config.maxRelationKeys }),
                ...(config.reactiveCache ? { reactiveCache: config.reactiveCache === true ? {} : config.reactiveCache } : {}),
                ...(config.relationExistsPushDown === undefined ? {} : { relationExistsPushDown: config.relationExistsPushDown }),
            });
${sourceBootstrap}${ttlBootstrap}        }

        protected override isCacheableQuery(functionPath: string): boolean {
            // NOT \`kind === "query"\` alone. A cache hit answers without running
            // \`handleRpc\`, so the \`internal\` refusal at the top of it is skipped —
            // and an \`internalQuery\` primed by a trusted system dispatch was then
            // served to an anonymous client that the refusal would have 404'd.
            //
            // \`perDispatch\` is the same argument one layer out: the procedure's
            // own \`.use()\` chain runs INSIDE \`handleRpc\`, so a hit skips it too.
            // A \`.use(rateLimit(...))\` query was therefore charged once and then
            // served from the memo to every later request — each of which still
            // reached this Durable Object and still cost it a dispatch, so only
            // the accounting was skipped. Metering and memoizing are mutually
            // exclusive; the author asking for the first is choosing against the
            // second.
            const registered = LUNORA_FUNCTIONS[functionPath];

            return registered?.kind === "query" && registered.visibility !== "internal" && registered.perDispatch !== true;
        }

        protected override isPaidFunction(functionPath: string): boolean {
            return LUNORA_FUNCTIONS[functionPath]?.x402 !== undefined;
        }
`;
    /* eslint-enable no-secrets/no-secrets */

    const facadeBlock = hasTables
        ? `\n            const facade = db as unknown as Record<string, ReturnType<typeof bindTableFacade>>;
${schema.tables
    .map(
        // Always bind through `db` (the shard ctx-db) — even for `.global()`
        // tables. `createShardCtxDb` routes global ops to the D1 `globalDb`
        // internally AND stamps the read-dependency / change-broadcast hooks that
        // drive live subscriptions; binding a global facade straight to `globalDb`
        // would skip those, so a `ctx.db.<global>` read/write would never refresh
        // a subscriber of that table.
        (table) => `            facade[${JSON.stringify(table.name)}] = bindTableFacade(db, ${JSON.stringify(table.name)});`,
    )
    .join("\n")}
`
        : "";

    // The emitted `scheduler?:` field on the shard config below is `unknown`, and
    // the `as SchedulerLike` at each of its three remaining use sites is the cost
    // of that (the deferral facade's is gone: `withDeferredSchedules` is generic
    // and hands back the type it was given).
    // It is not laziness: `@lunora/scheduler`'s public `Scheduler.runAfter`/`runAt`
    // are generic with a REQUIRED `args` where `SchedulerLike` takes it optional,
    // so a function needing three parameters is not assignable to one callable
    // with two — typing the field `SchedulerLike` fails to compile in every app
    // that calls `createScheduler` directly. Reconciling those two signatures is
    // the real fix and is legal on a pre-release branch; until then the compiler
    // cannot guard this install, which is how the return type drifted from
    // `Promise<string>` across four gates without anything failing.
    // `ctx.kv` / `ctx.analytics` ride EVERY ctx: their builds run inline before
    // the ctx object literal and their props are spliced into it (like `ctx.ai`).
    // `ctx.secrets` is a CORE built-in — always present on every ctx (a lazy
    // Secrets Store reader over `env`), so its build/field are unconditional.
    const secretsBuild = `
            const secrets = createSecrets(env);
`;
    // NOTE: `notifyFragments.build` is intentionally NOT in `everyContextBuild` —
    // the notify facade needs `log`/`metrics`, which are built later in the context
    // builder, so its build is injected after them via `notifyBuild` below. Its
    // `contextField` (the `notify` / `push` ctx keys) still rides `everyContextField`.
    const everyContextBuild = `${accessFragments.build}${kvFragments.build}${flagsFragments.build}${analyticsFragments.build}${envFragments.build}${secretsBuild}`;
    const everyContextField = `${accessFragments.contextField}${kvFragments.contextField}${flagsFragments.contextField}${notifyFragments.contextField}${analyticsFragments.contextField}${envFragments.contextField}\n                secrets,`;
    // The relocated notify build — emitted after `log`/`metrics` are in scope.
    const notifyBuild = notifyFragments.build;

    // `ctx.images` / `ctx.sql` (Hyperdrive) / `ctx.browser` are ActionCtx-ONLY:
    // external, non-deterministic I/O the typed `ActionCtx` exposes but
    // `QueryCtx`/`MutationCtx` do not. We enforce that at the VALUE level too —
    // the binds run AND the props are attached only when the executing function
    // is an `action`, so a query/mutation handler never even has `ctx.sql` on the
    // object (its type already forbids it; this makes the runtime match). Gated
    // behind a single `isAction` check derived from the dispatch registry.
    // Each helper's ctx field is named after its local, so one list drives both
    // the attach here and the strip from a composed query's view of an action ctx.
    const actionOnlyFields = [
        ...(hasAi ? ["ai"] : []),
        ...(hasImages ? ["images"] : []),
        ...(hasHyperdrive ? ["sql"] : []),
        ...(hasBrowser ? ["browser"] : []),
        ...(hasR2sql ? ["r2sql"] : []),
        ...(hasPipelines ? ["pipelines"] : []),
        ...(hasX402 ? ["x402"] : []),
    ];
    const actionOnlyBuild = `${aiBuild}${imagesFragments.build}${hyperdriveFragments.build}${browserFragments.build}${r2sqlFragments.build}${pipelinesFragments.build}${x402Build}`;

    return `${GENERATED_HEADER}${importLines.join("\n")}

type FunctionKind = "action" | "mutation" | "query";

interface FunctionReference {
    __lunoraRef: string;
}

/** Foreign-key columns per table (\`v.id("target")\` fields) for the data browser. */
const LUNORA_TABLE_REFS = ${renderJsonData(tableReferences, "Record<string, Record<string, string>>")};

/** Declared indexes per table (secondary, search, geo, rank, vector) for the schema viewer. */
const LUNORA_TABLE_INDEXES = ${renderJsonData(tableIndexes, `Record<string, Array<{ fields: string[]; name: string; type: "geo" | "index" | "rank" | "search" | "vector"; unique?: boolean }>>`)};

/** Columns per table (typed, with PK/FK markers) for the studio's schema diagram, served via \`__lunora_admin__:describeTable\`. */
const LUNORA_TABLE_COLUMNS = ${renderJsonData(
        tableColumns,
        `Record<
    string,
    Array<{
        bucket?: string;
        enumValues?: string[];
        isStorage?: boolean;
        name: string;
        nullable?: boolean;
        onDelete?: "cascade" | "restrict" | "set null";
        optional: boolean;
        pk?: boolean;
        ref?: string;
        type: string;
    }>
>`,
    )};

/** Storage-key columns per table (\`v.storage(...)\` fields) for the file browser's records↔files join. */
const LUNORA_STORAGE_COLUMNS = ${renderJsonData(storageColumns, "Record<string, string[]>")};

/** Declarative TTL policies (\`.ttl(field, { after? })\`) the DO alarm sweep auto-expires rows for. */
const LUNORA_TTL_SWEEPS = ${renderJsonData(ttlSweeps, "Array<{ after?: number; field: string; softDeleteField?: string; table: string }>")};

/** Static schema advisories (computed by @lunora/advisor at codegen time) served via \`__lunora_admin__:getAdvisories\`. */
const LUNORA_ADVISORIES = ${renderJsonData(advisoryData, "AdvisoryFinding[]")};

/** Every declared procedure (discovered by @lunora/codegen) served via \`__lunora_admin__:getAdvisorProcedures\` — the health map's denominator. */
const LUNORA_ADVISOR_PROCEDURES = ${renderJsonData(advisorProcedureData, "AdvisorProcedure[]")};

/** Read-only RLS metadata (policies + roles discovered from \`.use(rls(...))\` chains) served via \`__lunora_admin__:rlsPolicies\` for the studio's RLS inspector. */
const LUNORA_RLS_METADATA = ${renderJsonData(rlsData, "RlsPoliciesResult")};
${shapeReadPolicyAssertion}
/** Read-only masking metadata (table + column + strategy discovered from \`.use(mask(...))\` chains) served via \`__lunora_admin__:maskPolicies\` for the studio's data-browser mask preview. */
const LUNORA_MASK_METADATA = ${renderJsonData(maskData, "MaskPoliciesResult")};

/** Read-only storage access-rule metadata (discovered from \`.use(storageRules(...))\` chains) served via \`__lunora_admin__:storageRules\` for the studio's access-rules view. */
const LUNORA_STORAGE_RULES = ${renderJsonData(storageRulesData, "StorageRulesResult")};

/** Which optional package-backed features this app wires up (discovered from imports / \`ctx.*\` reads / schema signals) served via \`__lunora_admin__:studioFeatures\` so the studio hides nav pages whose package isn't enabled. */
const LUNORA_STUDIO_FEATURES = ${renderJsonData(studioFeaturesData, "StudioFeaturesResult")};
${schemaSnapshotConst}${flagsOverrides.constant}${workflowsMetadataConst}${queuesMetadataConst}${containerSpecs}${workflowSpecs}${queueSpecs}${agentSpecs}
export interface ShardDOConfig {
    /** Opt into change-data-capture: records a post-image to \`__cdc_log\` on every write (backs streaming export + replay-PITR). */
    cdc?: boolean;
    /** Ceiling on the join keys one relation-crossing \`where\` predicate may pre-resolve via semijoin before failing closed. Omit for the engine default. */
    maxRelationKeys?: number;
    /** Enable the per-shard reactive query cache: \`true\` for the defaults, or an options object to tune the caps. Query results are memoized by \`(functionPath, args, identity)\` and invalidated by the ctx-db write hooks before the subscription broadcast, so subscribers never observe a pre-write value. Omitted (or \`false\`) keeps every dispatch re-running its handler. */
    reactiveCache?: boolean | { maxBytes?: number; maxEntries?: number };
    /** Resolution policy for a relation-crossing \`where\` whose child is co-located in this shard: \`"auto"\` (cost-based, the engine default), \`"always"\` (inline correlated EXISTS) or \`"never"\` (universal semijoin). All three return identical rows. */
    relationExistsPushDown?: "always" | "auto" | "never";
    /** Optional telemetry sink. When supplied, each \`ctx.log.*\` call is forwarded to \`sink.onLog\`. Pass the SAME sink you give \`createWorker({ observability })\` (which drives \`onRpc\`) to route both RPC and log events. */
    observability?: (env: Record<string, unknown>) => TelemetrySink | undefined;
    /** \`unknown\` because \`@lunora/scheduler\`'s \`Scheduler\` is not assignable to \`SchedulerLike\`; the shard casts it. */
    scheduler?: (env: Record<string, unknown>) => unknown;
    /** \`origin\` is the origin the current \`/rpc\` request reached the worker on — the fallback base for signed object URLs when no \`publicBaseUrl\` is configured. \`undefined\` off the synchronous dispatch path. */
    storage?: (env: Record<string, unknown>, origin?: string) => unknown;${vectorsConfigField}${aiConfigField}${kvFragments.configField}${flagsFragments.configField}${analyticsFragments.configField}${imagesFragments.configField}${hyperdriveFragments.configField}${browserFragments.configField}${r2sqlFragments.configField}${pipelinesFragments.configField}${paymentsConfigField}${x402ConfigField}${d1ConfigField}${hyperdriveGlobalConfigField}${sourceClientConfigField}
}
${renderThrowingStub("schedulerStub", schedulerMissing, ["cancel", "runAfter", "runAt"])}${renderThrowingStub("storageStub", storageMissing, ["delete", "download", "getMetadata", "getSignedUrl", "getUrl", "head", "list", "upload"], { sync: ["getUrl"] })}${globalDatabaseStub}${sourceClientCacheConst}${vectorsStub}${aiStub}${kvFragments.stub}${flagsFragments.stub}${analyticsFragments.stub}${imagesFragments.stub}${hyperdriveFragments.stub}${browserFragments.stub}${r2sqlFragments.stub}${pipelinesFragments.stub}${paymentStub}${x402Stub}
${DISPATCH_RUN_SOURCE}

/**
 * Build the project's shard Durable Object. Export the result as \`ShardDO\`
 * from the worker entry so wrangler binds it by name.
 */
export const createShardDO = (config: ShardDOConfig = {}): new (state: ShardDOState, env: unknown) => ShardDOBase =>
    class extends ShardDOBase {${constructorOverride}
        private migrated = false;

${DISPATCH_METHODS}
${relationFanout.override}
${SUBSCRIPTION_METHODS}
${customMutatorOverride}${shapeResolveOverride}${globalShapeReaderOverride}${externalSourceOverride}
        protected override lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor" | "whisper"): readonly string[] {
            return LUNORA_LIFECYCLE_HOOKS[event];
        }
${shardInitOverride}
        // One \`onQueryChange\` dispatch. Mirrors \`executeSubscription\` — the
        // socket-terminated half of the same reactivity — and differs only in who
        // consumes the result: the base's \`dispatchReactors\` stores the digest as
        // the new baseline and the footprint as the "should I even re-run this"
        // gate, instead of pushing a frame down a socket.
        //
        // Dispatched through \`runMutationTransaction\` because a reactor handler is
        // a mutation: its writes must commit all-or-nothing, the jobs it schedules
        // must wait for that commit, and the objects its row deletes orphaned must
        // be flushed once it lands. Safe to open a span here: the refresh drain
        // runs OUTSIDE any dispatch transaction (it is post-flush background work),
        // so this never nests.
        //
        // NO identity is threaded, and the ctx is built \`trusted\`. A reactor fires
        // because data moved, not because anyone asked, so there is no user for RLS
        // to scope to — it runs in the same system tier as migrations and the
        // external-source poll loop. Inheriting the shared per-request identity
        // would instead run an app's reactor as whichever user happened to write
        // last, which is worse than running it as nobody.
        protected override async runReactor(functionPath: string, previousDigest?: string): Promise<{ digest: string; ran: boolean; tables: readonly string[] } | undefined> {
            const registered = LUNORA_FUNCTIONS[functionPath];

            if (!registered || registered.kind !== "mutation") {
                return undefined;
            }

            this.ensureMigrated();

            const footprint = createReadFootprint();
            const ctx = this.buildCtx({ functionPath, headroom: this.subscriptionHeadroom(), onRead: footprint.onRead, onReadRange: footprint.onReadRange, trusted: true });
            const outcome = (await this.runMutationTransaction(ctx, async () =>
                registered.handler(ctx, { previousDigest } as unknown as Record<string, unknown>),
            )) as {
                digest: string;
                ran: boolean;
            };

            return { digest: outcome.digest, ran: outcome.ran, tables: [...footprint.tables] };
        }


        protected override tableRefs(table: string): Record<string, string> | undefined {
            return LUNORA_TABLE_REFS[table];
        }

        protected override tableIndexes(table: string): Array<{ fields: string[]; name: string; type: "geo" | "index" | "rank" | "search" | "vector"; unique?: boolean }> {
            return LUNORA_TABLE_INDEXES[table] ?? [];
        }

        protected override ttlSweeps(): ReadonlyArray<{ after?: number; field: string; softDeleteField?: string; table: string }> {
            return LUNORA_TTL_SWEEPS;
        }

        protected override tableColumns(table: string): Array<{
            bucket?: string;
            enumValues?: string[];
            isStorage?: boolean;
            name: string;
            nullable?: boolean;
            onDelete?: "cascade" | "restrict" | "set null";
            optional: boolean;
            pk?: boolean;
            ref?: string;
            type: string;
        }> {
            return LUNORA_TABLE_COLUMNS[table] ?? [];
        }

        protected override storageColumns(): Record<string, string[]> {
            return LUNORA_STORAGE_COLUMNS;
        }

        protected override rlsMetadata(): RlsPoliciesResult {
            return LUNORA_RLS_METADATA;
        }

        protected override maskMetadata(): MaskPoliciesResult {
            return LUNORA_MASK_METADATA;
        }

        protected override storageRulesMetadata(): StorageRulesResult {
            return LUNORA_STORAGE_RULES;
        }

        protected override studioFeatures(): StudioFeaturesResult {
            return LUNORA_STUDIO_FEATURES;
        }
${flagsOverrides.evaluateOverride}${flagsOverrides.subscriptionOverride}${workflowsMetadataOverride}${queuesMetadataOverride}
        protected override advisories(): AdvisoryFinding[] {
            return LUNORA_ADVISORIES;
        }

        protected override advisorProcedures(): AdvisorProcedure[] {
            return LUNORA_ADVISOR_PROCEDURES;
        }

${ADMIN_WRITE_METHODS}

        protected override ensureMigrated(): void {
            if (this.migrated) {
                return;
            }

            runShardMigrations(this.sql as SqlExec, schema as unknown as SchemaLike, { cdc: config.cdc ?? false${snapshotArgument} });
            this.migrated = true;
        }
${
    hasShardSearchIndexes
        ? `
        protected override runShardSearchBackfill(options: { maxPages?: number }): SearchBackfillProgress {
            // Migrations create the fts5 companions; without them every backfill
            // statement would raise "no such table" on a shard that has never
            // served a request.
            this.ensureMigrated();

            return backfillSearchIndexes(this.sql as SqlExec, schema as unknown as SchemaLike, options);
        }
`
        : ""
}${vectorSyncMethod}
${renderBuildContext({ actionOnlyFields, agentsBuild, agentsContextField, containersBuild, containersContextField, databaseOptions, everyContextBuild, everyContextField, facadeBlock, globalDatabaseLine, notifyBuild, ormContextField, paymentsBuild, paymentsContextField, queuesBuild, queuesContextField, vectorsBuild, vectorsContextField, workflowsBuild, workflowsContextField, actionOnlyBuild })}
    };
`;
};

export default emitShard;
