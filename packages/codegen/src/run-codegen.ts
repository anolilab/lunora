import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { runAdvisor } from "@lunora/advisor";
import { LunoraError } from "@lunora/errors";
import type { Project } from "ts-morph";

import { serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
import { advisorEvidenceOf } from "./advisor-evidence";
import { applyAdvisorPolicy } from "./advisor-floor";
import type { CallSites } from "./architecture";
import { buildArchitecture, emitArchitectureModule } from "./architecture";
import assertNoNamespaceCollisions from "./assert-namespace-collisions";
import { createCodegenProject } from "./codegen-project";
import { buildDeclarationSurface } from "./declaration-surface";
import discoverCallEdges from "./discover/call-edges";
import type { ErasedReturn } from "./discover/erased-returns";
import { collectErasures, erasedReturnFindings } from "./discover/erased-returns";
import { discoverFlagKeys } from "./discover/flag-keys";
import discoverFunctions from "./discover/functions";
import resolveStandardSchemaType from "./discover/functions/resolve-standard-schema-type";
import discoverHttpRoutes from "./discover/http-routes";
import discoverInserts from "./discover/inserts";
import { assertJurisdictionMoveAcknowledged, findDoAuthDeclaration } from "./discover/jurisdiction-move";
import discoverMaskHasNonLiteralPolicy from "./discover/mask-procedures/has-non-literal-policy";
import discoverMaskMetadata from "./discover/mask-procedures/metadata";
import discoverMigrations from "./discover/migrations";
import { discoverModules, resolveModules } from "./discover/modules";
import { discoverMutators } from "./discover/mutators";
import readPackageDependencies from "./discover/package-dependencies";
import hasPaymentStoreTables from "./discover/payment-store-tables";
import { assertPrivacyCoverage, discoverPrivacyCoverage } from "./discover/privacy-coverage";
import discoverQueries from "./discover/queries";
import discoverRlsMetadata from "./discover/rls-procedures/metadata";
import discoverSchema from "./discover/schema";
import { discoverShapes } from "./discover/shapes";
import { buildStudioFeatures } from "./discover/studio-features";
import discoverTableWrites from "./discover/table-writes";
import discoverUnreadableArguments from "./discover/unreadable-arguments";
import discoverUnregisteredProcedures from "./discover/unregistered-procedures";
import discoverWorkflowCalls from "./discover/workflow-calls";
import {
    buildStorageColumns,
    emitAgents,
    emitApi,
    emitCollections,
    emitContainers,
    emitCrons,
    emitDrizzleSchema,
    emitDurableObjects,
    emitFunctions,
    emitInternalApi,
    emitQueues,
    emitScheduler,
    emitSeed,
    emitShard,
    emitShardRegistry,
    emitVectors,
    emitWorkflows,
    emitWranglerCronTriggers,
    queueAliasFindings,
} from "./emit";
import { emitServiceDeclarations } from "./emit/service-declarations";
import { emitApp } from "./emit-app";
import { isD1GlobalTable, isHyperdriveGlobalTable } from "./global-backend";
import type { AgentIR, FunctionIR, HttpRouteIR, MaskMetadataIR, MigrationIR, MutatorIR, ShapeIR, WorkflowIR } from "./ir";
import { setStandardTypeResolver } from "./parse-validator";
import { resolveCodegenTarget } from "./platform-target";
import { readMergeDurableObjects } from "./project-config-file";
import { projectFileMatches, syncProjectFile, writeGeneratedFiles, writeIfChanged } from "./run-codegen-files";
import type { CodegenOptions, CodegenResult } from "./run-codegen-types";
import { buildSchemaSnapshot } from "./schema-drift";
import { buildSpecArtifacts } from "./spec-artifacts";

/**
 * Committed, tracked baseline file holding the blessed structural schema
 * snapshot the pre-deploy drift gate diffs against. Lives in `lunora/` (NOT the
 * gitignored `_generated/`) so it is committed alongside `schema.ts`. Leading
 * dot keeps it tucked away next to the schema it describes.
 */
const SCHEMA_SNAPSHOT_FILENAME = ".lunora-schema.json";

/**
 * Whether opt-in codegen timing is enabled. Gated on a truthy
 * `LUNORA_CODEGEN_TIMING` env var so a normal run is byte-for-byte unchanged:
 * no timers are read, no summary is printed. An empty string (`""`) counts as
 * unset, matching how shells export blank vars.
 */
const isTimingEnabled = (): boolean => {
    const flag = process.env["LUNORA_CODEGEN_TIMING"];

    return flag !== undefined && flag !== "";
};

/**
 * Normalise a path to POSIX (forward-slash) separators. ts-morph's
 * `SourceFile.getFilePath()` always returns forward slashes regardless of
 * platform, so any path compared against it must be normalised first or the
 * comparison silently fails on Windows.
 */

/* eslint-disable jsdoc/check-indentation, no-secrets/no-secrets -- intentional nested bullet list; the `discoverMaskHasNonLiteralPolicy` back-tick reference isn't a credential */

/**
 * Fail closed (plan 208, Phase 1) when a `defineShape` replicates a table any
 * `.use(mask(...))` chain masks a column on. A shape runs no procedure, so
 * `.use(mask(...))` never executes for its membership reads — without this
 * check it would replicate a masked column's raw value to every subscribed
 * client, silently. Masking a shape's replicated rows (Phase 2) isn't built
 * yet, so the only safe answer today is to refuse the combination outright —
 * the same secure-by-default posture RLS's `.rls("required")` denial takes
 * for a policy-less table.
 *
 * Cross-checks project-wide static facts — `discoverShapes`' `ShapeIR.table`,
 * `discoverMaskMetadata`'s masked `(table, column)` pairs, and
 * `discoverMaskHasNonLiteralPolicy`'s "codegen couldn't read every mask policy"
 * signal — rather than reading any runtime tag/registry, so this rejects the
 * collision at build time, before a single Durable Object ships. Runs
 * unconditionally (all three inputs are computed regardless of the `lint`
 * option), because a security invariant must not be optional the way an
 * advisor lint finding is.
 *
 * Two inputs codegen can't statically resolve to a certain answer, handled by
 * failing closed rather than silently passing:
 *
 * - A shape's `table` isn't a string literal (e.g. `defineShape({ table: t,
 *   ... })` for a hoisted `t`) — `ShapeIR.table` is `undefined`, and codegen
 *   cannot rule out that `t` names a masked table. Only enforced when the
 *   project masks at least one column somewhere — a mask-free project has
 *   nothing such a shape could leak, so it's let through unconditionally.
 * - A `mask(policies)` call's `policies` argument is a variable reference
 *   rather than an inline object literal (e.g. `mask(sharedPolicies)`) — it
 *   contributes zero columns to `maskMetadata`, so the per-table lookup below
 *   has no evidence for whichever table(s) it actually masks. Once codegen
 *   can't enumerate every masked column, it can't clear ANY shape, so this
 *   fires unconditionally whenever the project declares both such a call and
 *   at least one shape.
 */
/* eslint-enable jsdoc/check-indentation, no-secrets/no-secrets */
const assertNoMaskedShapeTable = (shapes: ReadonlyArray<ShapeIR>, maskMetadata: MaskMetadataIR, hasNonLiteralMaskPolicy: boolean): void => {
    if (hasNonLiteralMaskPolicy && shapes.length > 0) {
        const shapeList = shapes.map((shape) => `"${shape.exportName}"`).join(", ");

        throw new LunoraError(
            "MASK_UNSUPPORTED",
            `This project declares a \`mask(...)\` policy whose argument isn't a plain object literal (e.g. \`mask(sharedPolicies)\` referencing a hoisted variable), or contains a spread (\`...shared\`) or computed key (\`[name]:\`) codegen can't enumerate, so codegen can't tell which columns it masks. Because the project also declares replication shape(s) (${shapeList}), codegen can't verify none of them replicate a table that policy masks — inline every table and column as literal keys so codegen can verify it, or remove the affected shape(s).`,
            { status: 422 },
        );
    }

    const maskedColumnsByTable = new Map<string, string[]>();

    for (const column of maskMetadata.columns) {
        const columns = maskedColumnsByTable.get(column.table) ?? [];

        columns.push(column.column);
        maskedColumnsByTable.set(column.table, columns);
    }

    const projectHasMaskedColumns = maskMetadata.columns.length > 0;

    for (const shape of shapes) {
        if (shape.table === undefined) {
            // Codegen couldn't statically prove which table this shape targets — its
            // `table` config value isn't a string literal (see `tableLiteralFrom`).
            // A mask-free project has nothing this shape could leak, so it's let
            // through; a project that masks ANY column can't rule out this shape
            // targeting one of them, and a shape runs no procedure (so
            // `.use(mask(...))` never applies to it) — fail closed rather than risk
            // replicating a masked column raw.
            if (projectHasMaskedColumns) {
                throw new LunoraError(
                    "MASK_UNSUPPORTED",
                    `defineShape "${shape.exportName}" has a non-literal \`table\` (a variable or expression, not a string literal), so codegen can't statically verify it doesn't replicate a table that masks a column. This project masks at least one column elsewhere, so the combination can't be proven safe — change "${shape.exportName}"'s \`table\` to a plain string literal so codegen can verify it, or remove the mask(s) on the table it targets.`,
                    { status: 422 },
                );
            }

            continue;
        }

        const maskedColumns = maskedColumnsByTable.get(shape.table);

        if (maskedColumns === undefined) {
            continue;
        }

        const columnList = maskedColumns.map((column) => `"${column}"`).join(", ");

        throw new LunoraError(
            "MASK_UNSUPPORTED",
            `defineShape "${shape.exportName}" replicates table "${shape.table}", which masks column(s) ${columnList} on at least one procedure. A shape runs no procedure, so \`.use(mask(...))\` never applies to its replicated rows — remove the shape, unmask the table, or wait for shape-masking support.`,
            { status: 422 },
        );
    }
};

/**
 * Ceiling on the infer → render → re-infer loop below. Cold trees were measured
 * converging on the fourth pass, so the cap sits above that with room. It is a spin guard, not a correctness guarantee — see
 * {@link inferToFixpoint} for what happens when it is reached.
 */
const MAX_INFERENCE_PASSES = 8;

/**
 * Infer every handler's return type against a project that already contains the
 * `api.ts` / `functions.ts` those types are read back through.
 *
 * `dataModel.ts` and `server.ts` are rendered into the project before any
 * inference happens, precisely so a cold tree cannot collapse the types that
 * depend on them. These two cannot be seeded that way, because their content IS
 * the inference result: a handler doing `ctx.runQuery(api.messages.list)` — or a
 * streaming route whose chunk type comes back through one — infers against a
 * module that does not exist yet on a cold `_generated/`, collapses, and the
 * collapse is written out. The tree then converges only on a later invocation,
 * which is what pushes projects into wrapping the CLI in a
 * run-until-the-hash-stops-changing loop (issue #283).
 *
 * So iterate: infer, render, feed the render back, re-infer. The loop returns as
 * soon as a pass's render matches what inference already saw — the first pass on
 * any warm tree, where `syncProjectFile` leaves an identical file alone and
 * nothing is re-inferred, so a converged project pays one extra render and no
 * extra inference.
 *
 * The render that matched is RETURNED rather than recomputed by the caller. Two
 * call sites building the same emit arguments 150 lines apart is how the
 * convergence check silently starts comparing something other than what gets
 * written.
 *
 * **Reaching the cap is not an error.** A handler that embeds its own result —
 * `{ deeper: await createCaller(ctx).grow.grow() }`, the shape of any
 * self-referential tree query — grows its inferred type by one level per pass
 * and has no fixpoint to reach. Throwing there would turn a project that
 * previously built (with that one return typed `unknown`) into one that produces
 * no `_generated/` at all. So the last render wins, exactly as it did before this
 * loop existed: never worse than one run's output, usually better.
 */
const inferToFixpoint = (options: {
    agents: ReadonlyArray<AgentIR>;
    apiPath: string;
    generatedFunctionsPath: string;
    internalPath: string;
    lunoraDirectory: string;
    migrations: ReadonlyArray<MigrationIR>;
    project: Project;
    roomsSupported: boolean;
    shapes: ReadonlyArray<ShapeIR>;
    usesSandbox: boolean;
    useUmbrella: boolean;
    workflows: ReadonlyArray<WorkflowIR>;
}): {
    apiContent: string;
    erased: ReadonlyArray<ErasedReturn>;
    functions: ReadonlyArray<FunctionIR>;
    functionsContent: string;
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    internalContent: string;
    mutators: ReadonlyArray<MutatorIR>;
} => {
    const {
        agents,
        apiPath,
        generatedFunctionsPath,
        internalPath,
        lunoraDirectory,
        migrations,
        project,
        roomsSupported,
        shapes,
        usesSandbox,
        useUmbrella,
        workflows,
    } = options;

    // The three discoverers that read an inferred return type through
    // `unwrapHandlerReturn`, and therefore the three that have to be re-run when
    // the files those types resolve against change. Everything else in the
    // pipeline reads syntax, not inference, and stays outside.
    //
    // Each pass collects its own erasures, and only the pass whose render is
    // returned is reported: an earlier pass's are stale, since a later one may
    // render the same return.
    const discover = () =>
        collectErasures(() => {
            const functions = discoverFunctions(project, lunoraDirectory);
            const mutators = discoverMutators(project, lunoraDirectory);

            return { functions, httpRoutes: discoverHttpRoutes(project, lunoraDirectory), mutators };
        });

    let {
        erased,
        value: { functions, httpRoutes, mutators },
    } = discover();

    // Two files whose sanitized namespaces collide (`a-b.ts` + `a_b.ts`) would
    // emit the same key twice into `_generated/api.ts` — a TS2300 inside
    // generated code, with no pointer back to the two files that caused it.
    //
    // Once per namespace SPACE: `api.*` and `httpStreams.*` are separate emitted
    // objects, so a function file may share a namespace with a route file, but
    // two streaming-route files may not — and only `.stream()` routes are
    // grouped by namespace at all, so the plain verbs stay out of it.
    assertNoNamespaceCollisions([...functions, ...mutators].map((definition) => definition.filePath));
    assertNoNamespaceCollisions(
        httpRoutes.filter((route) => route.stream).map((route) => route.filePath),
        "http-stream",
    );

    // A target that rejects `typedWebSockets` gets no room surface: its room registrations are not emitted.
    for (let pass = 1; ; pass += 1) {
        // Recomputed each pass: the inference refines `functions`, and the emit must see that.
        const emittedFunctions = roomsSupported ? functions : functions.filter((definition) => definition.channel?.kind !== "room");

        const apiContent = emitApi({ agents, functions: emittedFunctions, httpRoutes, mutators, useUmbrella, workflows });
        const functionsContent = emitFunctions({ agents, functions: emittedFunctions, migrations, mutators, shapes, useUmbrella, usesSandbox });
        const internalContent = emitInternalApi({ functions, useUmbrella });

        // Converged, or out of budget — either way this render is the answer, and
        // the budget check sits HERE so the final pass's re-inference is never
        // computed and then discarded.
        if (
            pass >= MAX_INFERENCE_PASSES ||
            (projectFileMatches(project, apiPath, apiContent) &&
                projectFileMatches(project, internalPath, internalContent) &&
                projectFileMatches(project, generatedFunctionsPath, functionsContent))
        ) {
            return { apiContent, erased, functions, functionsContent, httpRoutes, internalContent, mutators };
        }

        syncProjectFile(project, apiPath, apiContent);
        syncProjectFile(project, internalPath, internalContent);
        syncProjectFile(project, generatedFunctionsPath, functionsContent);

        ({
            erased,
            value: { functions, httpRoutes, mutators },
        } = discover());
    }
};

/**
 * Top-level codegen entry. Parses `<projectRoot>/lunora/schema.ts` and every
 * function file under `<projectRoot>/lunora/`, then writes
 * `_generated/{api,server,dataModel}.ts` next to them.
 *
 * When `LUNORA_CODEGEN_TIMING` is set (truthy), a single diagnostic summary
 * line is written to stderr with the total wall time and the discovery-vs-emit
 * split — opt-in instrumentation that is otherwise zero-cost and side-effect-free
 * on the returned {@link CodegenResult}.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- top-level codegen orchestrator; splitting further would obscure the linear pipeline
export const runCodegen = (options: CodegenOptions): CodegenResult => {
    const timingEnabled = isTimingEnabled();
    const startedAt = timingEnabled ? performance.now() : 0;

    const lunoraDirectory = join(options.projectRoot, options.lunoraDirectory ?? "lunora");
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        throw new LunoraError("INTERNAL", `schema.ts not found at ${schemaPath}`);
    }

    // Reuse an injected Project (the caller owns refreshing its source files
    // from disk — see refreshCodegenProject) when provided; otherwise build one
    // exactly as createCodegenProject would.
    const project = options.project ?? createCodegenProject(lunoraDirectory);

    // MUST run before anything parses validators — `discoverSchema` and
    // `discoverFunctions` below are where `v.from(...)` is read, and an
    // unregistered resolver silently yields `unknown` for every one of them.
    // Recovering the type needs the checker plus the generated-file
    // renderability guards, both of which live in `discover/functions`;
    // registered here rather than imported by the parser, which would be a
    // cycle.
    setStandardTypeResolver(resolveStandardSchemaType);

    const schema = discoverSchema(project, schemaPath, options.projectRoot);

    // Plan 468 WS H: a table that holds user data must be covered by a privacy dataset or excluded.
    assertPrivacyCoverage(schema.tables, discoverPrivacyCoverage(project, lunoraDirectory, readPackageDependencies(options.projectRoot)));

    // Phase 1 — everything that must be resolved and RENDERED before a single
    // handler's type is inferred against it. See `declaration-surface.ts` for why
    // that ordering is load-bearing; the short version is that a handler's type
    // resolves through `dataModel.ts`/`server.ts`, so rendering them late makes
    // pass 1 infer against the previous run's declarations.
    const {
        agents,
        capabilities,
        containers,
        crons,
        dataModelContent,
        dependencies,
        entryCronTriggers,
        env,
        featureUsage,
        hasFlags,
        hasNotify,
        identity,
        platformGate,
        queues,
        serverContent,
        services,
        storageRulesMetadata,
        topics,
        usesSandbox,
        useUmbrella,
        workflows,
    } = buildDeclarationSurface({ lunoraDirectory, project, projectRoot: options.projectRoot, schema, target: options.target });

    // Before anything is written: pinning DO-backed auth that was unpinned
    // before would start it out empty, and nothing else about the upgrade
    // changes the schema, so this is the one place that can stop it.
    assertJurisdictionMoveAcknowledged(schema, schema.jurisdiction === undefined ? undefined : findDoAuthDeclaration(project, lunoraDirectory));

    const outputDirectory = join(lunoraDirectory, "_generated");
    const dataModelPath = join(outputDirectory, "dataModel.ts");
    const serverPath = join(outputDirectory, "server.ts");
    const apiPath = join(outputDirectory, "api.ts");
    const internalPath = join(outputDirectory, "internal.ts");
    const generatedFunctionsPath = join(outputDirectory, "functions.ts");

    // In MEMORY only — the disk write waits for the write phase with everything
    // else. `discoverFunctions` infers against the ts-morph `Project`, not the
    // filesystem, so this is the whole of what makes the declarations current;
    // writing here as well would buy nothing and cost atomicity. Anything between
    // this point and the write phase can throw (`assertNoMaskedShapeTable`, a
    // parse error in a handler), and an early write would leave a new
    // `dataModel.ts` beside a stale `api.ts`/`shard.ts` — worst when a table was
    // REMOVED, since `Doc_x` disappears while the files still referencing it do
    // not, and the resulting errors point at generated code rather than the real
    // cause. It would also fire the `_generated/**` watcher mid-failure in the
    // Vite dev loop.
    syncProjectFile(project, dataModelPath, dataModelContent);
    syncProjectFile(project, serverPath, serverContent);

    // `server.ts` types each RPC service from its declaration snapshot, so the
    // snapshots join the Project before any handler's type is inferred through them.
    const serviceDeclarations: Record<string, string> = Object.fromEntries(
        services
            .filter((service) => service.rpcEntrypoint !== undefined)
            .flatMap((service) => Object.entries(emitServiceDeclarations(service, outputDirectory))),
    );

    for (const [path, content] of Object.entries(serviceDeclarations)) {
        syncProjectFile(project, join(outputDirectory, path), content);
    }

    const migrations = discoverMigrations(project, lunoraDirectory);

    // Local-first sync engine (Phase 7): replication shapes (`lunora/shapes.ts`)
    // and custom mutators (`lunora/mutators.ts`). Shapes gate the generated DO's
    // `resolveShape` override + the `_generated/collections.ts` factories;
    // mutators register into `LUNORA_FUNCTIONS` (transaction-wrapped) and the
    // `isCustomMutator` push-protocol override. Both return `[]` when their file
    // is absent, so a project without them emits byte-identical generated code.
    // Neither reads a handler's inferred return type, so both sit outside the
    // fixpoint below — unlike `discoverHttpRoutes`, which does.
    const shapes = discoverShapes(project, lunoraDirectory);

    // Rooms ride hibernated shard sockets: a target that rejects `typedWebSockets` gets no room
    // surface. The gate has already reported the rejection as `platform_unsupported_feature`.
    const roomsSupported = platformGate.signals.typedWebSockets !== false;

    const { apiContent, erased, functions, functionsContent, httpRoutes, internalContent, mutators } = inferToFixpoint({
        agents,
        apiPath,
        generatedFunctionsPath,
        internalPath,
        roomsSupported,
        lunoraDirectory,
        migrations,
        project,
        shapes,
        useUmbrella,
        usesSandbox,
        workflows,
    });

    // Modules (a `lunora/<dir>/module.ts`, plus every installed component) feed
    // the cross-module advisor lint for every app. Only a DECLARED module turns on
    // the architecture manifest and module-tagged specs, so an app that declares
    // none keeps byte-identical output.
    const declaredModules = discoverModules(project, lunoraDirectory);
    const modules = resolveModules(
        declaredModules,
        schema,
        [...functions, ...httpRoutes].map((entry) => entry.filePath),
    );
    const wantsArchitecture = declaredModules.length > 0;

    // The call-edge/query/insert/workflow-call walks feed both the advisor and the
    // architecture manifest, so they run once when either needs them — and not
    // at all on a `lint: false` run of an app with no declared module.
    const callSites: CallSites | undefined =
        options.lint === false && !wantsArchitecture
            ? undefined
            : {
                  callEdges: discoverCallEdges(project, lunoraDirectory),
                  inserts: discoverInserts(project, lunoraDirectory),
                  queries: discoverQueries(project, lunoraDirectory, functions),
                  tableWrites: discoverTableWrites(project, lunoraDirectory),
                  workflowCalls: discoverWorkflowCalls(project, lunoraDirectory),
              };

    // Static advisories (unindexed FKs, redundant indexes, unknown index/relation
    // fields, filter-without-index, …). Cheap, derived from the schema + the
    // discovered query reads, and run here so a problem surfaces at codegen time
    // — before it ships. Opt out via `lint: false`. Presentation is the caller's
    // job: the result carries the findings and each caller surfaces them through
    // its own channel (the CLI logger, the vite overlay, the studio Advisors
    // table) rather than this library printing.
    //
    // One context feeds both the findings and the scored health map, so the two can
    // never describe different evidence. Built lazily — the ternary keeps every
    // discover* call out of a `lint: false` run.
    const advisorContext =
        options.lint === false || callSites === undefined
            ? undefined
            : advisorEvidenceOf(project, lunoraDirectory, {
                  agents,
                  callSites,
                  containers,
                  crons,
                  functions,
                  modules,
                  mutators,
                  queues,
                  schema,
                  shapes,
                  workflows,
                  wranglerVariables: options.wranglerVariables,
              });

    // Two ways a procedure reaches `api.ts` wrong, both silent until now, both
    // reported alongside the advisor's findings so they travel the same channel
    // to the terminal and the studio: a binding whose TYPE is a registered
    // procedure but which never reached `api.ts` at all (dropped by the
    // syntactic scan), and one that did reach it carrying fewer arguments than
    // the runtime enforces (an argument record codegen could not read).
    //
    // `advisor.minSeverity` in `lunora.config.*` drops findings below that level
    // from everything downstream (the result, and so the terminal, and the
    // emitted shard) but never an ERROR, so the blocking gate is unaffected.
    const advisories =
        advisorContext === undefined
            ? []
            : applyAdvisorPolicy(options.projectRoot, [
                  ...runAdvisor(advisorContext, { source: "static" }),
                  ...discoverUnregisteredProcedures(project, lunoraDirectory, {
                      // Workflows, queues, agents and containers record no file in
                      // their IR — their `name` is the addressable identity — so
                      // they key on the export name alone.
                      byName: new Set([...workflows, ...queues, ...agents, ...containers].map((entry) => entry.exportName)),
                      byPath: new Set([...functions, ...mutators, ...shapes, ...migrations].map((entry) => `${entry.filePath}:${entry.exportName}`)),
                  }),
                  ...discoverUnreadableArguments(project, lunoraDirectory),
                  // The third, and the output-side twin of the second: a return
                  // type codegen could render as neither a name nor a structure,
                  // so `api.ts` says `unknown` where the runtime returns a shape.
                  // Collected by the discovery pass above — the signal
                  // ("expansion produced nothing") exists only at the moment of
                  // the fallback, so it cannot be re-derived here.
                  ...erasedReturnFindings(erased, lunoraDirectory),
                  // A wrangler.jsonc queue rename the registry cannot route as written.
                  ...queueAliasFindings(queues, options.wranglerQueueProducers),
              ]);

    // Read-only RLS metadata (policies + roles) the studio's RLS inspector lists,
    // emitted into the generated ShardDO's `rlsMetadata()` override. Statically
    // discovered from every `.use(rls(...))` chain — never the `when` predicate.
    const rlsMetadata = discoverRlsMetadata(project, lunoraDirectory);

    // Read-only masking metadata (table + column + strategy) the studio's
    // data-browser mask toggle previews, emitted into the generated ShardDO's
    // `maskMetadata()` override. Statically discovered from every
    // `.use(mask(...))` chain — never the masking closure.
    const maskMetadata = discoverMaskMetadata(project, lunoraDirectory);

    // Fail closed (plan 208, Phase 1): a `defineShape` runs no procedure, so
    // masking never applies to its replicated rows — reject the combination
    // before it ships rather than replicate a masked column raw. Unconditional
    // (not gated behind `lint`), unlike the advisories below. Also covers the
    // two cases codegen can't prove safe rather than prove unsafe — a shape's
    // non-literal `table` and a mask() call's non-literal `policies` — see
    // eslint-disable-next-line no-secrets/no-secrets -- false positive: this is a function name referenced in a comment, not a secret.
    // `discoverMaskHasNonLiteralPolicy` and `assertNoMaskedShapeTable`'s docblock.
    assertNoMaskedShapeTable(shapes, maskMetadata, discoverMaskHasNonLiteralPolicy(project, lunoraDirectory));

    // Statically-discovered `ctx.flags.<type>("key")` reads — the generated
    // ShardDO's `evaluateFlags` (studio Flags page) + the reactive read override
    // (`useFlag`) iterate these. Only meaningful when a provider is wired.
    const flagKeys = hasFlags ? discoverFlagKeys(project, lunoraDirectory) : [];

    // The platform gate's `vectorStore` verdict, named once for every consumer
    // below. `undefined` means the app never declared a vector index, which must
    // not withhold anything; only an explicit `false` is a rejection. Spelling
    // that three-state comparison out per call site is what let one of them —
    // the studio nav — keep advertising the feature the other two withheld.
    const vectorStoreSupported = platformGate.signals.vectorStore !== false;

    // Which optional features the studio should show a nav page for.
    // `buildStudioFeatures` OR's the code-usage flags with the schema/project
    // signals the `lunora/`-scoped scan can't see: storage columns + access rules,
    // declared crons, and — crucially for packages wired only in the worker entry
    // (e.g. `@lunora/mail`) — the project's declared dependencies. Emitted into the
    // generated ShardDO's `studioFeatures()` override.
    //
    // The dependency arm fails OPEN: a page whose backing package is installed
    // shows even when the scan cannot see the wiring, because those pages degrade
    // to an empty state. `vectors` is the exception and gates on the schema
    // declaration alone — its endpoints 400 without a registry to serve, so
    // failing open there would fail open into an error. See
    // `buildStudioFeatures`' docblock.
    const studioFeatures = buildStudioFeatures(featureUsage, {
        containerCount: containers.length,
        cronCount: crons.length,
        dependencies,
        // Payments gates on the store tables the panel reads being declared, not on a
        // bare `@lunora/payment` dependency (which may be present only to reuse the
        // package's pure webhook helpers) — see `hasPaymentStoreTables`.
        hasPaymentTables: hasPaymentStoreTables(schema.tables),
        queueCount: queues.length,
        storageColumnCount: Object.keys(buildStorageColumns(schema)).length,
        storageRuleCount: storageRulesMetadata.rules.length,
        vectorIndexCount: schema.vectorIndexes.length,
        target: resolveCodegenTarget(options.projectRoot, options.target),
        vectorStoreSupported,
        workflowCount: workflows.length,
    });

    // Boundary between the discovery phase (all `discover*` passes + the inline
    // discovers `lintSchema` drives + the metadata discovers above) and the emit
    // phase (the `emit*`/`build*`/serialize work + the file writes below).
    // `dataModel.ts`/`server.ts` are already RENDERED further up — they are the
    // declaration surface inference reads, so they cannot wait for this phase.
    // They are not yet WRITTEN: the write happens with every other file below, so
    // a throw between here and there leaves `_generated/` untouched.
    const emitStartedAt = timingEnabled ? performance.now() : 0;

    // Structural schema snapshot for the pre-deploy drift gate. Built from the
    // discovered schema + the declared migration ids; the CLI gate diffs the
    // CURRENT snapshot against the committed baseline. Always computed (cheap,
    // pure) and returned in `CodegenResult`; the baseline file is (re-)blessed
    // only when it is absent (first capture) or `updateSchemaBaseline` is set —
    // so a routine codegen run never silently moves the goalposts the gate
    // measures against.
    const schemaSnapshot = buildSchemaSnapshot(
        schema,
        migrations.map((migration) => migration.id),
    );
    // The SAME snapshot is threaded into the emitted shard so the DO records it
    // in its `__lunora_schema_history` ledger on cold start (plan 200). One
    // builder feeds both the deploy gate and the Studio's schema history, so the
    // two can never describe different shapes.
    const shardContent = emitShard({
        // `_generated/shard.ts` is committed, and this finding is a fact about
        // the machine codegen ran on rather than about the app — regenerating
        // against a stale `dist/` would write it into a tracked file, so the
        // diff would differ per developer. It still reaches the terminal through
        // `CodegenResult.advisories`, which is where a fact about this run
        // belongs. (`procedure_not_registered` is embedded like every other
        // finding, and it is resolution-dependent too — a cold `dist/` drops it
        // from the emitted list. That is the pre-existing cost of embedding
        // advisories at all, not something this filter can fix.)
        advisories: advisories.filter((advisory) => advisory.name !== "procedure_type_check_unavailable"),
        advisorProcedures: advisorContext?.procedureProtections ?? [],
        agents,
        capabilities,
        containers,
        env,
        flagKeys,
        hasFlags,
        hasNotify,
        hasRooms: roomsSupported && functions.some((definition) => definition.channel?.kind === "room"),
        // The gate's verdict, exactly as `emitServer`/`emitApp` receive it. The
        // shard emitter recomputed the flag from `schema.vectorIndexes` instead,
        // so the DO kept the whole Vectorize wiring on a host rating
        // `vectorStore: "unsupported"` — a `generated.shard` byte-identical to
        // the Cloudflare one while the type surface was withheld.
        hasVectors: vectorStoreSupported,
        maskMetadata,
        mutators,
        queues,
        rlsMetadata,
        schema,
        schemaSnapshot,
        shapes,
        services,
        storageRules: storageRulesMetadata,
        studioFeatures,
        topics,
        useUmbrella,
        workflows,
    });
    // `_generated/collections.ts` — one TanStack DB collection factory per shape.
    // Emitted only when the project declares shapes AND installs the `@lunora/db`
    // add-on (which ships `lunoraCollectionOptions`); `""` otherwise so
    // `writeIfPresent` skips it.
    const collectionsContent = emitCollections(shapes, dependencies.has("@lunora/db"), useUmbrella);
    const containersContent = emitContainers(containers, schema.jurisdiction);
    const workflowsContent = emitWorkflows(workflows);
    const agentsContent = emitAgents(agents);
    const queuesContent = emitQueues(queues, options.wranglerQueueProducers);
    const cronsContent = emitCrons(crons);
    const schedulerContent = emitScheduler(studioFeatures.scheduler);
    const shardRegistryContent = emitShardRegistry(schema.tables, useUmbrella);
    const durableObjectsContent = readMergeDurableObjects(options.projectRoot) ? emitDurableObjects(useUmbrella) : "";
    const vectorsContent = emitVectors(schema.vectorIndexes);
    const drizzleFiles = emitDrizzleSchema(schema, useUmbrella);
    // Only emit the project-bound seed client when `@lunora/seed` is a declared
    // dependency — seeding is a dev/test concern, so a project that never
    // installs it keeps a clean `_generated/` and never imports the package.
    const seedContent = emitSeed(dependencies.has("@lunora/seed"));

    // Which API spec(s) the run emits. Defaults to `"openapi"` so existing
    // projects (and the golden fixtures) keep writing only `openapi.json`.
    const apiSpec = options.apiSpec ?? "openapi";
    const wantsOpenApi = apiSpec === "openapi" || apiSpec === "both";
    const wantsOpenRpc = apiSpec === "openrpc" || apiSpec === "both";

    // The fluent worker-composition builder. Emits one method per package-backed
    // capability the app uses (so IntelliSense lists exactly what's configurable),
    // each fanned into both the DO-side `createShardDO` factory and the worker-side
    // `createWorker` options. Lives in generated code (not the dependency-free
    // `@lunora/runtime`) so it can import the add-on packages the app installed.
    const appContent = emitApp({
        // Usage-only, never a dependency signal: each long-tail method's
        // parameter type reads `ShardConfig[configKey]` (e.g. `.kv()` reads
        // `ShardConfig["kv"]`), and the shard emits that config field on the
        // same usage set — so the method can never reference a missing type.
        capabilities,
        // Inbound-email agents (`defineAgent({ onEmail })`) → wire the worker's
        // top-level `email()` handler to each agent's exported workflow so
        // received mail starts a durable run. Empty for email-free (and agent-free)
        // projects, so the emitted app.ts stays byte-identical.
        emailAgents: agents
            .filter((agent) => agent.onEmail === true)
            .map((agent) => {
                return { className: agent.className, exportName: agent.exportName };
            }),
        hasAccess: dependencies.has("@lunora/cloudflare-access"),
        hasAuth: dependencies.has("@lunora/auth"),
        // Worker-composition framework adapters expose a `withLunora` over
        // `withFrameworkWorker`; when one is installed, surface `.buildFrameworkWorker()`.
        // So does a hand-composed entry — an app that folds its framework's SSR
        // handler in itself, as the Rsbuild TanStack Start template does, with no
        // adapter to depend on. The path is `@lunora/config`'s
        // `COMPOSED_WORKER_ENTRY`, the file `lunora deploy` bundles in place of
        // `main`; spelled out because `@lunora/config` depends on this package.
        hasFramework:
            dependencies.has("@lunora/astro") ||
            dependencies.has("@lunora/svelte") ||
            dependencies.has("@lunora/vue") ||
            existsSync(join(options.projectRoot, "src", "worker.ts")),
        // `hasGlobal` means **D1-backed** global tables (the `.global()` / D1
        // app-builder wiring); Hyperdrive-backed globals are gated separately by
        // `hasHyperdriveGlobal` so an app picks the right binding+package.
        hasGlobal: schema.tables.some((table) => isD1GlobalTable(table)),
        hasHyperdriveGlobal: schema.tables.some((table) => isHyperdriveGlobalTable(table)),
        // Auto-wire the studio's KV introspector on the SAME condition the nav
        // gates its tab on (`studioFeatures.kv` = ctx.kv usage OR a declared
        // `@lunora/bindings` dep), so a visible KV tab always has a working
        // backend — never the reverse.
        hasKvIntrospector: studioFeatures.kv,
        hasNotify,
        hasQueue: queues.some((queue) => queue.mode === "push"),
        hasScheduler: studioFeatures.scheduler,
        // The same schema signal `emitShard` gates the shard config's source-client
        // field and the ingest poll on, so the builder method and the config field
        // it writes to are emitted together or not at all.
        hasSourcedTables: schema.tables.some((table) => table.externalSource !== undefined),
        hasStorage: studioFeatures.storage,
        // The gate's verdict, on the same convention `emitServer`/`emitShard`
        // take it: the emitter AND's it with the declaration itself. This call
        // site used to pass the CONJUNCTION under the same prop name, so the one
        // flag meant two different things depending on which emitter read it.
        hasVectors: vectorStoreSupported,
        hasWorkflow: workflows.length > 0,
        // The single `defineIdentity(...)` contract (Plan 080). Wires
        // `options.identity` so the runtime trust boundary validates every
        // resolved identity before it becomes `ctx.auth`; `undefined` keeps the
        // emitted app.ts byte-identical to before this feature.
        identity,
        // Schema `.jurisdiction("…")` → pin the generated worker's DOs to the region.
        jurisdiction: schema.jurisdiction,
        // `{ pinAuth: true }` — only then is DO-backed auth pinned too.
        jurisdictionPinsAuth: schema.jurisdictionPinsAuth === true,
        // Drives the emitted `listSchemaTables` and `resolveTableSharding`.
        tables: schema.tables.map((table) => {
            return { name: table.name, shardMode: table.shardMode };
        }),
        useUmbrella,
        // The app's own declaration, which `emitApp` AND's with `hasVectors`.
        // `emitApp` takes no schema (only the table list), so the count it
        // needs to make the same decision its siblings make has to come in.
        vectorIndexCount: schema.vectorIndexes.length,
        // Voice-enabled agents (`defineAgent({ voice: … })`) → wire the worker's
        // `/_lunora/voice/<exportName>` route to each agent's `VOICE_*` DO
        // namespace. Empty for voice-free (and agent-free) projects, so the
        // emitted app.ts stays byte-identical.
        voiceAgents: agents
            .filter((agent) => agent.voice === true && agent.voiceBindingName !== undefined)
            .map((agent) => {
                return { bindingName: agent.voiceBindingName as string, exportName: agent.exportName };
            }),
        wantsArchitecture,
        wantsOpenApi,
        wantsOpenRpc,
    });

    // Both spec documents, each as its `.json` and `.ts` artifact. See `buildSpecArtifacts`.
    const { openApiContent, openApiModuleContent, openRpcContent, openRpcModuleContent } = buildSpecArtifacts({
        functions,
        httpRoutes,
        modules,
        projectRoot: options.projectRoot,
        wantsArchitecture,
    });

    // The architecture manifest (module catalog + call graph) is emitted only
    // once the app declares a module, so an app without one keeps byte-identical
    // output.
    const architectureDocument =
        wantsArchitecture && callSites !== undefined
            ? buildArchitecture({
                  ...callSites,
                  crons,
                  functions,
                  httpRoutes,
                  modules,
                  queues,
                  schema,
                  services,
                  topics,
                  workflows,
              })
            : undefined;
    const schemaSnapshotPath = join(lunoraDirectory, SCHEMA_SNAPSHOT_FILENAME);
    const schemaSnapshotExists = existsSync(schemaSnapshotPath);

    // The `_generated/` files this run emits, in write order. Which files those
    // are depends on the project (conditional features, `apiSpec`), so it is
    // recorded here rather than restated by each caller — the CLI used to print
    // a hardcoded three-file list that had been wrong since the fourth file was
    // added, and nothing could have caught it.
    const writtenFiles = options.dryRun
        ? []
        : writeGeneratedFiles(outputDirectory, [
              { content: appContent, kind: "always", name: "app.ts" },
              { content: dataModelContent, kind: "always", name: "dataModel.ts" },
              { content: apiContent, kind: "always", name: "api.ts" },
              { content: internalContent, kind: "always", name: "internal.ts" },
              { content: serverContent, kind: "always", name: "server.ts" },
              { content: functionsContent, kind: "always", name: "functions.ts" },
              { content: shardContent, kind: "always", name: "shard.ts" },
              { content: cronsContent, kind: "always", name: "crons.ts" },
              { content: vectorsContent, kind: "always", name: "vectors.ts" },
              { content: drizzleFiles.global, kind: "always", name: "drizzle.global.ts" },
              { content: drizzleFiles.shard, kind: "always", name: "drizzle.shard.ts" },
              // Conditionally-emitted files: each is written only when its feature is in use
              // (the `emit*` helper returns `""` otherwise), so projects that don't use them
              // keep a clean `_generated/` and never import the package.
              //   - containers.ts  → `@lunora/container`, when containers are declared
              //   - workflows.ts   → `@lunora/workflow`, when workflows are declared
              //   - agents.ts      → `@lunora/agent`, when agents are declared
              //   - seed.ts        → `@lunora/seed`, when it's a declared dependency
              //   - collections.ts → `@lunora/db`, when the project declares shapes
              { content: containersContent, kind: "optional", name: "containers.ts" },
              { content: workflowsContent, kind: "optional", name: "workflows.ts" },
              { content: agentsContent, kind: "optional", name: "agents.ts" },
              { content: queuesContent, kind: "optional", name: "queues.ts" },
              { content: schedulerContent, kind: "optional", name: "scheduler.ts" },
              { content: shardRegistryContent, kind: "optional", name: "shardRegistry.ts" },
              { content: durableObjectsContent, kind: "optional", name: "durableObjects.ts" },
              { content: seedContent, kind: "optional", name: "seed.ts" },
              { content: collectionsContent, kind: "optional", name: "collections.ts" },
              { files: serviceDeclarations, kind: "services" },
              // The `.json` is the portable artifact for external tooling; the `.ts` (same
              // document, inlined) is what the worker imports and passes to `createWorker({
              // openApiSpec })`. Both are gated on the same `apiSpec` choice so they regenerate
              // together, and an unselected format is removed rather than left stale.
              { content: wantsOpenApi ? openApiContent : "", kind: "optional", name: "openapi.json" },
              { content: wantsOpenApi ? openApiModuleContent : "", kind: "optional", name: "openapi.ts" },
              { content: wantsOpenRpc ? openRpcContent : "", kind: "optional", name: "openrpc.json" },
              { content: wantsOpenRpc ? openRpcModuleContent : "", kind: "optional", name: "openrpc.ts" },
              // Same pairing as the specs: the `.json` for tooling, the `.ts` for `createWorker({ architecture })`,
              // both removed when the last module goes.
              {
                  content: architectureDocument === undefined ? "" : `${JSON.stringify(architectureDocument, undefined, 2)}\n`,
                  kind: "optional",
                  name: "architecture.json",
              },
              {
                  content: architectureDocument === undefined ? "" : emitArchitectureModule(architectureDocument),
                  kind: "optional",
                  name: "architecture.ts",
              },
          ]);

    // Bless the schema baseline on first capture (so a project gets a committed snapshot the
    // moment it runs codegen) or when explicitly asked to refresh it. The CLI gate reads the
    // existing baseline BEFORE calling codegen, so re-blessing here never hides drift from that run.
    if (!options.dryRun && (!schemaSnapshotExists || options.updateSchemaBaseline === true)) {
        writeIfChanged(schemaSnapshotPath, serializeSchemaSnapshot(schemaSnapshot));
    }

    if (timingEnabled) {
        const finishedAt = performance.now();
        const total = Math.round(finishedAt - startedAt);
        const discovery = Math.round(emitStartedAt - startedAt);
        const emit = Math.round(finishedAt - emitStartedAt);

        // Diagnostic-only; stderr keeps it out of any stdout the caller parses.
        // eslint-disable-next-line no-console -- opt-in diagnostic line, gated on LUNORA_CODEGEN_TIMING
        console.error(`@lunora/codegen: codegen took ${total.toString()}ms (discovery ${discovery.toString()}ms, emit ${emit.toString()}ms)`);
    }

    return {
        advisories,
        advisorContext,
        agents,
        architecture: architectureDocument,
        containers,
        // Declared jobs plus the schedules `createWorker` is configured with
        // directly (`backupCron`, `crons` keys). Both need a wrangler trigger to
        // fire, and both count against Cloudflare's per-worker Cron Trigger cap,
        // so the reconciler and the CLI's limit warning have to see one list.
        cronTriggers: [...new Set([...emitWranglerCronTriggers(crons), ...entryCronTriggers])],
        generated: {
            agents: agentsContent,
            api: apiContent,
            app: appContent,
            collections: collectionsContent,
            containers: containersContent,
            crons: cronsContent,
            dataModel: dataModelContent,
            drizzleGlobal: drizzleFiles.global,
            drizzleShard: drizzleFiles.shard,
            functions: functionsContent,
            internal: internalContent,
            openApi: openApiContent,
            openApiModule: openApiModuleContent,
            openRpc: openRpcContent,
            openRpcModule: openRpcModuleContent,
            queues: queuesContent,
            seed: seedContent,
            server: serverContent,
            shard: shardContent,
            vectors: vectorsContent,
            workflows: workflowsContent,
        },
        migrations,
        outputDirectory,
        platformDiagnostics: platformGate.diagnostics,
        queues,
        schemaSnapshot,
        schemaSnapshotPath,
        workflows,
        writtenFiles,
    };
};

// Exports kept at end-of-file per the package's `import/exports-last` rule.
export { createCodegenProject, findTsconfig, refreshCodegenProject } from "./codegen-project";
export type { CodegenOptions, CodegenResult } from "./run-codegen-types";
export { SCHEMA_SNAPSHOT_FILENAME };
