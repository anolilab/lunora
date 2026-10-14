/**
 * Options and result of `runCodegen`, the public contract of the codegen entry point.
 */
import type { Finding, LintContext } from "@lunora/advisor";
import type { Project } from "ts-morph";

import type { ArchitectureManifest } from "../../../shared/architecture-manifest";
import type { SchemaSnapshot } from "../../../shared/schema-snapshot";
import { createCodegenProject, refreshCodegenProject } from "./codegen-project";
import type { AgentIR, ContainerIR, MigrationIR, QueueIR, WorkflowIR, WranglerQueueProducerIR, WranglerVariableIR } from "./ir";
import type { PlatformDiagnostic } from "./platform-target";

export interface CodegenOptions {
    /**
     * Which machine-readable API spec(s) to emit into `_generated/`.
     *
     * `"openapi"` (the default) writes only `openapi.json` (OpenAPI 3.1; covers
     * both the RPC functions and `httpRouter()` REST routes). `"openrpc"` writes
     * only `openrpc.json` (OpenRPC 1.x; the RPC functions only — OpenRPC cannot
     * represent REST routes). `"both"` writes both files; `"none"` writes neither.
     *
     * Regardless of the choice, `CodegenResult.generated.openApi` and `.openRpc`
     * always carry the rendered string (computation is cheap and pure); only the
     * on-disk write is gated by this option.
     */
    apiSpec?: "both" | "none" | "openapi" | "openrpc";

    /**
     * When true, run discovery + emit (so any schema/function parse error
     * surfaces) but skip writing files to `_generated/`. The returned
     * `outputDirectory` is still the path that *would* have been written.
     */
    dryRun?: boolean;

    /**
     * Run the static schema advisor (unindexed FKs, …) during codegen.
     * Defaults to `true`. When `false`, `CodegenResult.advisories` is empty.
     * Computed regardless of `dryRun`; codegen never prints them — see
     * {@link CodegenResult.advisories}.
     */
    lint?: boolean;

    /** Override the lunora subdirectory name. Defaults to `"lunora"`. */
    lunoraDirectory?: string;

    /**
     * Reuse a previously-constructed ts-morph {@link Project} instead of building
     * a fresh one each run. The caller owns refreshing its source files from disk
     * (see {@link refreshCodegenProject}) — codegen does not re-read changed files
     * off an injected Project. Built via {@link createCodegenProject} when absent.
     * Used by the Vite dev-loop to avoid re-parsing the whole TS program on every
     * save; omit it (CLI one-shot path) to get the default fresh-Project behaviour.
     */
    project?: Project;

    /** Project root containing the `lunora/` directory. */
    projectRoot: string;

    /**
     * The deploy target codegen tailors the emitted `ctx.*` surface to.
     * Defaults to `"cloudflare"` — whose capability matrix marks every feature
     * native or emulated, so the default output is unchanged (byte-identical
     * goldens). A target that marks a used feature unsupported omits its
     * `ctx.*` surface and reports it in {@link CodegenResult.platformDiagnostics}.
     * Only `"cloudflare"` is registered until other per-target `@lunora/platform`
     * matrices land; an unknown target emits the full surface un-gated and a
     * `platform_unknown_target` diagnostic.
     */
    target?: string;

    /**
     * Re-bless the committed schema-drift baseline (`lunora/.lunora-schema.json`)
     * with the current structural snapshot. The baseline is ALWAYS written on
     * first capture (when the file is absent); set this to overwrite an existing
     * one — e.g. after the developer has added the data migration that justifies
     * a breaking change. Ignored when `dryRun` is true.
     */
    updateSchemaBaseline?: boolean;

    /**
     * Every `queues.producers[]` entry of `wrangler.jsonc`, top level and each
     * `env.<name>` block. A producer naming a push queue's binding with another
     * queue name becomes an extra route in `_generated/queues.ts`, so a batch from
     * a per-environment rename (`jobs-preview`) reaches the `jobs` handler.
     * Produced by `@lunora/config`'s `wranglerCodegenInputs`; `[]` when there is
     * no wrangler config. Required so a caller that writes `_generated/` cannot
     * forget it and emit a registry without the renames.
     */
    wranglerQueueProducers: ReadonlyArray<WranglerQueueProducerIR>;

    /**
     * Committed `wrangler.jsonc` `vars` entries that hold plaintext secrets — the
     * `plaintext_secret_in_wrangler_vars` lint input. Produced by `@lunora/config`
     * (which reads `wrangler.jsonc`) and threaded through by the CLI / Vite plugin;
     * codegen only forwards it to the advisor. Absent when no wrangler config is
     * present or the caller doesn't scan it.
     */
    wranglerVariables?: ReadonlyArray<WranglerVariableIR>;
}

export interface CodegenResult {
    /**
     * The normalized advisor evidence the findings were produced from, so a
     * caller can score it into a health map (`scoreAdvisor`) without re-running
     * discovery. `undefined` under `lint: false`.
     *
     * Deliberately not scored here: the map carries a `generatedAt` stamp, and
     * codegen's result stays a pure function of the sources.
     */
    advisorContext?: LintContext;

    /**
     * Static schema advisor findings (e.g. unindexed foreign keys) produced
     * this run, minus any below `lunora.config`'s `advisor.minSeverity` (never
     * an ERROR). Empty when `lint` is `false` or the schema is clean. Codegen
     * does not print these itself — each caller presents them through its own
     * channel (the CLI logger, the vite overlay, the studio Advisors table).
     * `formatAdvisories` is exported for a plain multi-line rendering.
     */
    advisories: ReadonlyArray<Finding>;

    /**
     * Agents discovered from `defineAgent` exports in `lunora/agents.ts` — the
     * list the config layer reconciles into wrangler's `workflows[]` array (an
     * agent compiles onto a Cloudflare Workflow). Agents are NOT Durable Objects,
     * so this adds no binding or migration. Empty when the project declares none.
     */
    agents: ReadonlyArray<AgentIR>;

    /**
     * The architecture manifest written to `_generated/architecture.json` —
     * `lunora deploy` diffs it against the last deployed one. `undefined` when the
     * app declares no module.
     */
    architecture?: ArchitectureManifest;

    /**
     * Containers discovered from `defineContainer` exports in
     * `lunora/containers.ts` — the list the config layer reconciles into
     * wrangler's `containers[]`, `CONTAINER_*` Durable Object bindings, and
     * migration classes. Empty when the project declares no containers.
     */
    containers: ReadonlyArray<ContainerIR>;

    /**
     * Deduplicated cron schedules discovered from `cronJobs()` definitions —
     * the array the vite plugin reconciles into `wrangler.jsonc`'s
     * `triggers.crons`. Empty when the project declares no crons.
     */
    cronTriggers: ReadonlyArray<string>;

    generated: {
        /** WorkflowEntrypoint classes for declared agents (`_generated/agents.ts`); `""` (and not written) when no agents are declared. */
        agents: string;
        api: string;
        /** Fluent worker-composition builder (`_generated/app.ts`) — `defineApp()`. Always written. */
        app: string;
        /** Partial-replication collection factories (`_generated/collections.ts`); `""` (and not written) unless the project declares shapes and installs `@lunora/db`. */
        collections: string;
        /** Container DO classes (`_generated/containers.ts`); `""` (and not written) when no containers are declared. */
        containers: string;
        crons: string;
        dataModel: string;
        drizzleGlobal: string;
        drizzleShard: string;
        functions: string;
        /** `internal.*` references to the internal functions (`_generated/internal.ts`), kept out of `api.ts` so a client bundle never carries them. */
        internal: string;
        /** OpenAPI 3.1.0 document (`_generated/openapi.json`), pretty-printed JSON. */
        openApi: string;

        /**
         * OpenAPI document as an importable TS module (`_generated/openapi.ts`) —
         * `export const openApiSpec`, the worker imports it for
         * `createWorker({ openApiSpec })`. Same document as `openApi`. Written
         * alongside `openapi.json` whenever `apiSpec` includes `openapi`.
         */
        openApiModule: string;
        /** OpenRPC 1.x document (`_generated/openrpc.json`), pretty-printed JSON. Always computed; written only when `apiSpec` includes `openrpc`. */
        openRpc: string;

        /**
         * OpenRPC document as an importable TS module (`_generated/openrpc.ts`) —
         * `export const openRpcSpec`, for `createWorker({ openRpcSpec })`. Same
         * document as `openRpc`. Written alongside `openrpc.json` whenever
         * `apiSpec` includes `openrpc`.
         */
        openRpcModule: string;
        /** Push-consumer queue registry (`_generated/queues.ts`); `""` (and not written) when no push queues are declared. */
        queues: string;
        /** Project-bound seed client (`_generated/seed.ts`); `""` (and not written) when `@lunora/seed` is not a declared dependency. */
        seed: string;
        server: string;
        shard: string;
        /** Static vector-index registry (`_generated/vectors.ts`) — `LUNORA_VECTOR_INDEXES`. Empty array body when the schema declares none. */
        vectors: string;
        /** WorkflowEntrypoint classes (`_generated/workflows.ts`); `""` (and not written) when no workflows are declared. */
        workflows: string;
    };

    /**
     * Data migrations discovered from `defineMigration` exports under `lunora/`,
     * each with the table it iterates. The drift gate matches a NEW id against
     * its table so a backfill only excuses breaking drift on the table it
     * actually visits. Empty when the project declares none.
     */
    migrations: ReadonlyArray<MigrationIR>;
    outputDirectory: string;

    /**
     * Portability diagnostics for the requested {@link CodegenOptions.target}:
     * `ctx.*` features the app uses that the target does not support (omitted
     * from the emitted surface), or an unknown target. Empty for a
     * fully-supported app on the default Cloudflare target. Presentation is the
     * caller's job, like {@link CodegenResult.advisories}.
     */
    platformDiagnostics: ReadonlyArray<PlatformDiagnostic>;

    /**
     * Queues discovered from `defineQueue` exports in `lunora/queues.ts` — the
     * list the config layer reconciles into wrangler's `queues.producers[]` /
     * `queues.consumers[]`. Queues are NOT Durable Objects, so this adds no
     * binding or migration. Empty when the project declares no queues.
     */
    queues: ReadonlyArray<QueueIR>;

    /**
     * The CURRENT structural schema snapshot computed this run (tables + field
     * kinds/optionality + indexes/relations/shard mode + declared migration ids).
     * The pre-deploy drift gate diffs this against the committed baseline read
     * from {@link CodegenResult.schemaSnapshotPath}. Always present, even on a
     * `dryRun`.
     */
    schemaSnapshot: SchemaSnapshot;

    /** Absolute path of the committed baseline file (`lunora/.lunora-schema.json`). */
    schemaSnapshotPath: string;

    /**
     * Workflows discovered from `defineWorkflow` exports in
     * `lunora/workflows.ts` — the list the config layer reconciles into
     * wrangler's `workflows[]` array. Workflows are NOT Durable Objects, so this
     * adds no binding or migration. Empty when the project declares no workflows.
     */
    workflows: ReadonlyArray<WorkflowIR>;

    /**
     * The `_generated/` file names this run emitted, in write order, relative to
     * {@link CodegenResult.outputDirectory}. Conditional files appear only when
     * their feature is in use, and the spec artifacts only for the requested
     * `apiSpec` — so this is what the project actually has, not a fixed list.
     * Empty under `dryRun` (nothing is written). Callers report from this rather
     * than restating the set, which is how the CLI came to advertise three of
     * twelve files.
     */
    writtenFiles: ReadonlyArray<string>;
}
