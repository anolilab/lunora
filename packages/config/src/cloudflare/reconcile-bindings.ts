/**
 * Write the bindings implied by `inferLunoraBindings` into the project's
 * `wrangler.jsonc`, idempotently and comment-preservingly.
 *
 * Mirrors `reconcileWranglerCrons`: structural edits via `jsonc-parser`'s
 * `modify` / `applyEdits` so user comments and formatting survive. Idempotent
 * by design — a binding already present (matched by name) is never duplicated,
 * so it is safe to run on every dev-server start and before every deploy.
 *
 * Scope: the Durable Object bindings the worker entry exports (plus their
 * `migrations[].new_sqlite_classes` entries) and the `DB` D1 binding for
 * `.global()` schemas. Capabilities that can't be provisioned safely — R2
 * (user-defined bucket name), or auth/scheduler used without the matching DO
 * exported — are returned as warnings rather than written, since a binding
 * referencing an unexported class would make `wrangler deploy` fail.
 */
import { writeFileSync } from "node:fs";

import { containerBuildTag } from "@lunora/container";

import type { InferredAgent, InferredBindings, InferredContainer, InferredWorkflow } from "../infer-bindings";
import { applyModify } from "../jsonc-edit";
import type { DurableObjectSpec, GeneratedClassModule } from "../worker-entry";
import { readManifest } from "./lunora-manifest";
import type { OwnedTuning } from "./reconcile-queues";
import { readOwnedTuning, reconcileEnvQueues, reconcileQueues, recordOwnedTuning } from "./reconcile-queues";
import collectWarnings from "./reconcile-warnings";
import { objectBindingEntries, stringEntries } from "./validate-bindings";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";
import type { MigrationEntry, ReconcileStep, WranglerShape } from "./wrangler-shape";

/**
 * Placeholder `database_id` written for an auto-provisioned `DB` binding. It is
 * intentionally not a valid id so a deploy can't silently target the wrong
 * database; reconciliation warns the user to replace it (see the D1 warning in
 * `reconcileWranglerBindings`).
 */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

/**
 * A container/workflow that is declared (so codegen emits its class) but the
 * worker entry never re-exports — the one wiring step the generators can't always
 * do for the developer. wrangler rejects a `class_name` the deployed worker
 * doesn't export, so a deploy fails late on this; surfacing it as structured data
 * lets the Vite plugin raise it in the dev error overlay (not just the console)
 * the moment the gap appears. The human-readable form is also folded into
 * {@link ReconcileBindingsResult.warnings}.
 */
interface ExportGap {
    /** Generated class wrangler needs exported, e.g. `OrderPipelineWorkflow`. */
    className: string;
    /** The `lunora/{agents,containers,workflows}.ts` export name, e.g. `orderPipeline`. */
    exportName: string;
    /** Which declaration is unexported. */
    kind: "agent" | "container" | "workflow";
    /** The `_generated/{module}` to re-export from, e.g. `workflows`. */
    module: GeneratedClassModule;
}

interface ReconcileBindingsResult {
    /** Short labels for each binding written (e.g. `"SCHEDULER/SchedulerDO"`). */
    added: string[];
    /** `true` when `wrangler.jsonc` was rewritten. */
    changed: boolean;

    /**
     * Declared containers/workflows the worker entry doesn't re-export — the
     * structured form of the corresponding `warnings` entries, for the dev error
     * overlay. Empty when every declaration is wired.
     */
    exportGaps: ExportGap[];
    /** Reason reconciliation was skipped, for logging. */
    reason?: string;

    /**
     * Short labels for each EXISTING entry whose settings were brought in line
     * with its declaration (e.g. `"queues.consumers/receipt-queue (max_retries)"`).
     * Kept apart from `added` so a retune is not logged as a new binding.
     */
    updated: string[];
    /** Non-fatal hints for capabilities that cannot be auto-provisioned. */
    warnings: string[];
    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

/**
 * The declared-but-not-re-exported containers and workflows, as structured
 * {@link ExportGap}s. The same gaps `collectWarnings` renders into prose — kept
 * here as data so the Vite plugin can raise them in the error overlay with a
 * precise remediation, rather than re-parsing the warning strings.
 *
 * Exported because reconciliation is not the only caller that needs the answer:
 * `lunora codegen` and `lunora doctor` both want the gaps WITHOUT rewriting
 * `wrangler.jsonc`, which is the rest of what {@link reconcileWranglerBindings}
 * does. Deriving them again from `inferred.{containers,workflows,agents}` at each
 * call site is how one kind ends up silently uncovered.
 */
const collectExportGaps = (inferred: InferredBindings): ExportGap[] => {
    const kinds: ReadonlyArray<[ExportGap["kind"], ExportGap["module"], ReadonlyArray<{ className: string; exported: boolean; exportName: string }>]> = [
        ["container", "containers", inferred.containers],
        ["workflow", "workflows", inferred.workflows],
        ["agent", "agents", inferred.agents],
    ];

    return kinds.flatMap(([kind, module, declarations]) =>
        declarations
            .filter((declaration) => !declaration.exported)
            .map(({ className, exportName }) => {
                return { className, exportName, kind, module };
            }),
    );
};

/** Compute the lowest free `vN` `migrations` tag (`v1`, `v2`, …). */
const nextMigrationTag = (migrations: ReadonlyArray<MigrationEntry | null | undefined>): string => {
    const used = new Set(objectBindingEntries(migrations).map((migration) => migration.tag));
    let index = 1;

    while (used.has(`v${String(index)}`)) {
        index += 1;
    }

    return `v${String(index)}`;
};

/**
 * The Durable Object classes the `migrations` list already declares, replayed
 * in order exactly the way wrangler's own `getDeclaredDOClassNames` does:
 * `deleted_classes` removes, `renamed_classes` moves `from` → `to`, and the two
 * `new_*` lists add.
 *
 * Counting only the `new_*` lists made a class introduced by a rename look
 * unregistered, so reconcile appended a second `new_sqlite_classes` entry for
 * it — which wrangler then refuses ("Cannot apply new_sqlite_classes migration
 * to existing class X"), permanently, because the append is written to the
 * committed config with no rollback on the dev / prepare paths.
 */
const declaredClassNames = (migrations: ReadonlyArray<MigrationEntry | null | undefined>): Set<string> => {
    const declared = new Set<string>();

    // Normalised the same way (and with the same helpers) as the validator's
    // `foldMigrationClassKinds`, which folds this identical hand-edited list:
    // a bare walk threw a raw `TypeError` on a `null` record or rename entry,
    // and a non-array `"new_classes": "ShardDO"` folded in one CHARACTER per
    // iteration instead of the class name.
    for (const migration of objectBindingEntries(migrations)) {
        for (const className of stringEntries(migration.deleted_classes)) {
            declared.delete(className);
        }

        for (const { from, to } of objectBindingEntries(migration.renamed_classes)) {
            if (from !== undefined) {
                declared.delete(from);
            }

            if (to !== undefined) {
                declared.add(to);
            }
        }

        for (const className of [...stringEntries(migration.new_classes), ...stringEntries(migration.new_sqlite_classes)]) {
            declared.add(className);
        }
    }

    return declared;
};

/** Add any missing Durable Object bindings + their migration classes. Pure. */
const reconcileDurableObjects = (text: string, parsed: WranglerShape, required: ReadonlyArray<DurableObjectSpec>): ReconcileStep => {
    const existingBindings = parsed.durable_objects?.bindings ?? [];
    const existingNames = new Set(existingBindings.map((binding) => binding.name));
    const missing = required.filter((object) => !existingNames.has(object.binding));

    let nextText = text;
    const added: string[] = [];

    if (missing.length > 0) {
        const nextBindings = [
            ...existingBindings,
            ...missing.map((object) => {
                return { class_name: object.className, name: object.binding };
            }),
        ];

        nextText = applyModify(nextText, ["durable_objects", "bindings"], nextBindings);
        added.push(...missing.map((object) => `${object.binding}/${object.className}`));
    }

    const migrations = parsed.migrations ?? [];
    const missingClasses = required.map((object) => object.className).filter((className) => !declaredClassNames(migrations).has(className));

    if (missingClasses.length > 0) {
        const nextMigrations = [...migrations, { new_sqlite_classes: missingClasses, tag: nextMigrationTag(migrations) }];

        nextText = applyModify(nextText, ["migrations"], nextMigrations);
    }

    return { added, text: nextText };
};

/** Add the `DB` D1 binding for `.global()` schemas, if absent. Pure. */
const reconcileD1 = (text: string, parsed: WranglerShape): ReconcileStep => {
    const d1Bindings = parsed.d1_databases ?? [];

    if (d1Bindings.some((binding) => binding.binding === "DB")) {
        return { added: [], text };
    }

    const databaseName = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : "lunora";
    const nextD1 = [...d1Bindings, { binding: "DB", database_id: D1_PLACEHOLDER_ID, database_name: databaseName }];

    return { added: ["DB (D1)"], text: applyModify(text, ["d1_databases"], nextD1) };
};

/**
 * Add a self-describing single-`{ binding }` binding (`ai`, `browser`, `images`)
 * if absent. These share one shape — the binding name is the whole config, with
 * no remote id to mint — so each is written safely like `DB`, and one helper
 * covers all three. Idempotent on `parsed[key].binding`. Pure.
 */
const reconcileSelfDescribing = (text: string, parsed: WranglerShape, key: "ai" | "browser" | "images", binding: string, label: string): ReconcileStep => {
    const current = parsed[key]?.binding;

    if (typeof current === "string" && current.length > 0) {
        return { added: [], text };
    }

    return { added: [label], text: applyModify(text, [key], { binding }) };
};

/**
 * Add the `analytics_engine_datasets` binding for `@lunora/bindings/analytics` usage, if
 * absent. Self-describing: the `dataset` name is user-chosen and created lazily
 * on first write (no remote id to mint), so it auto-writes like the DO bindings.
 * The dataset defaults to the binding name on Cloudflare's side; we write it
 * explicitly to avoid drift. Idempotent on any existing `analytics_engine_datasets` entry. Pure.
 */
const reconcileAnalytics = (text: string, parsed: WranglerShape): ReconcileStep => {
    if ((parsed.analytics_engine_datasets?.length ?? 0) > 0) {
        return { added: [], text };
    }

    const nextDatasets = [{ binding: "ANALYTICS", dataset: "ANALYTICS" }];

    return { added: ["ANALYTICS (Analytics Engine)"], text: applyModify(text, ["analytics_engine_datasets"], nextDatasets) };
};

/**
 * Add the `worker_loaders` binding `jsCodeTool` reads (`LOADER`), if absent.
 * Self-describing — the binding name is the whole entry — so it auto-writes.
 * Idempotent on any existing `LOADER` entry; another loader binding is left
 * alone and `LOADER` added beside it. Pure.
 */
const reconcileWorkerLoaders = (text: string, parsed: WranglerShape): ReconcileStep => {
    const loaders = parsed.worker_loaders ?? [];

    if (loaders.some((loader) => loader.binding === "LOADER")) {
        return { added: [], text };
    }

    return { added: ["LOADER (Worker Loader)"], text: applyModify(text, ["worker_loaders"], [...loaders, { binding: "LOADER" }]) };
};

/** Map a camelCase custom instance type onto wrangler's snake_case fields. Pure. */
// eslint-disable-next-line sonarjs/function-return-type -- wrangler's instance_type IS a string-or-object union
const wranglerInstanceType = (instanceType: NonNullable<InferredContainer["instanceType"]>): Record<string, unknown> | string => {
    if (typeof instanceType === "string") {
        return instanceType;
    }

    const custom: Record<string, unknown> = {};

    if (instanceType.diskMb !== undefined) {
        custom.disk_mb = instanceType.diskMb;
    }

    if (instanceType.memoryMib !== undefined) {
        custom.memory_mib = instanceType.memoryMib;
    }

    if (instanceType.vcpu !== undefined) {
        custom.vcpu = instanceType.vcpu;
    }

    return custom;
};

/** The wrangler `containers[].image` for an inferred default-policy container. */
const imageRefFor = (container: InferredContainer, image: NonNullable<InferredContainer["image"]>): string => {
    if (image.kind === "dockerfile") {
        return image.dockerfilePath;
    }

    if (image.kind === "registry") {
        return image.reference;
    }

    // A Railpack `{ build }` source: `lunora deploy` builds + pushes this local
    // tag (derived from the export name) before wrangler runs, so wrangler.jsonc
    // references the pushed tag. See `containerBuildTag`.
    return containerBuildTag(container.exportName);
};

/**
 * Render a `durable_object`-scheduled container's `containers[]` entry: the
 * policy plus its named images (wrangler `dockerfile` / `build_context` /
 * `build_vars`, or a registry `image`). The instance size is chosen at start,
 * and the policy takes no `max_instances` or rollout, so none are written.
 */
const durableObjectContainerEntryFor = (container: InferredContainer): Record<string, unknown> => {
    const images: Record<string, Record<string, unknown>> = {};

    for (const [name, image] of Object.entries(container.images ?? {})) {
        images[name] =
            image.kind === "registry"
                ? { image: image.reference }
                : {
                      build_context: image.buildContext,
                      dockerfile: image.dockerfilePath,
                      ...(container.buildArgs === undefined ? {} : { build_vars: container.buildArgs }),
                  };
    }

    return {
        class_name: container.className,
        scheduling_policy: "durable_object",
        ...(Object.keys(images).length > 0 ? { images } : {}),
        ...(container.name === undefined ? {} : { name: container.name }),
    };
};

/** Render one wrangler `containers[]` entry from an inferred container. Pure. */
const containerEntryFor = (container: InferredContainer): Record<string, unknown> => {
    const { image } = container;

    if (container.schedulingPolicy === "durable_object" || image === undefined) {
        return durableObjectContainerEntryFor(container);
    }

    const entry: Record<string, unknown> = {
        class_name: container.className,
        image: imageRefFor(container, image),
    };

    if (image.kind === "dockerfile") {
        entry.image_build_context = image.buildContext;
    }

    // Build args (image_vars) only make sense for an image lunora builds.
    if (container.buildArgs !== undefined && image.kind !== "registry") {
        entry.image_vars = container.buildArgs;
    }

    if (container.instanceType !== undefined) {
        entry.instance_type = wranglerInstanceType(container.instanceType);
    }

    if (container.maxInstances !== undefined) {
        entry.max_instances = container.maxInstances;
    }

    if (container.name !== undefined) {
        entry.name = container.name;
    }

    if (container.rollout?.stepPercentage !== undefined) {
        entry.rollout_step_percentage = container.rollout.stepPercentage;
    }

    if (container.rollout?.gracePeriodSeconds !== undefined) {
        entry.rollout_active_grace_period = container.rollout.gracePeriodSeconds;
    }

    return entry;
};

/**
 * Add any missing `containers[]` entries (matched by `class_name`). The Durable
 * Object bindings + migration classes for containers ride through
 * `reconcileDurableObjects` with the built-in DOs; `observability` is handled
 * unconditionally by `reconcileObservability` (not just for containers). Pure.
 */
const reconcileContainers = (text: string, parsed: WranglerShape, containers: ReadonlyArray<InferredContainer>): ReconcileStep => {
    const existing = parsed.containers ?? [];
    const existingClasses = new Set(existing.map((entry) => entry.class_name));
    const missing = containers.filter((container) => !existingClasses.has(container.className));

    if (missing.length === 0) {
        return { added: [], text };
    }

    const nextText = applyModify(text, ["containers"], [...existing, ...missing.map((container) => containerEntryFor(container))]);

    return { added: missing.map((container) => `containers/${container.className}`), text: nextText };
};

/**
 * Switch Workers Observability on when the key is entirely absent, so every
 * Lunora worker ships with Workers Logs + Traces enabled by default (not just
 * container apps). `head_sampling_rate: 1` keeps all logs initially — a sensible
 * default users can dial down. An explicit `enabled: false` is a user billing
 * decision and is left untouched (`collectWarnings` flags the container case).
 * Pure.
 */
const reconcileObservability = (text: string, parsed: WranglerShape): ReconcileStep => {
    if (parsed.observability !== undefined) {
        return { added: [], text };
    }

    const nextText = applyModify(text, ["observability"], { enabled: true, head_sampling_rate: 1 });

    return { added: ["observability"], text: nextText };
};

/**
 * Render one wrangler `workflows[]` entry from an inferred workflow or agent —
 * an agent compiles onto a Cloudflare Workflow, so its wrangler footprint is
 * identical: a `{ binding, class_name, name }` entry in the same array. Pure.
 */
const workflowEntryFor = (workflow: InferredAgent | InferredWorkflow): Record<string, unknown> => {
    return { binding: workflow.bindingName, class_name: workflow.className, name: workflow.name };
};

/**
 * Add any missing `workflows[]` entries (matched by `class_name`) from both
 * `defineWorkflow` and `defineAgent` exports — an agent compiles onto a
 * Cloudflare Workflow, so both land in the SAME `workflows[]` array, and one
 * step owns that key (the reconcile pipeline's disjoint-key invariant forbids a
 * second step rewriting `workflows[]` off the now-stale `parsed`). Workflows and
 * agents are NOT Durable Objects, so — unlike containers — this writes ONLY the
 * `workflows[]` array: no `durable_objects` binding, no `migrations` class, no
 * `observability` toggle.
 *
 * Add-only: an entry whose `class_name` no declaration generates is left in
 * place and reported by `orphanedEntryWarnings` (`reconcile-warnings.ts`) instead — see there for
 * why removal needs ownership this file cannot establish. Pure.
 */
const reconcileWorkflows = (
    text: string,
    parsed: WranglerShape,
    workflows: ReadonlyArray<InferredWorkflow>,
    agents: ReadonlyArray<InferredAgent> = [],
): ReconcileStep => {
    const existing = parsed.workflows ?? [];
    const existingClasses = new Set(existing.map((entry) => entry.class_name));
    const missingWorkflows = workflows.filter((workflow) => !existingClasses.has(workflow.className));
    const missingAgents = agents.filter((agent) => !existingClasses.has(agent.className));

    if (missingWorkflows.length === 0 && missingAgents.length === 0) {
        return { added: [], text };
    }

    const nextText = applyModify(
        text,
        ["workflows"],
        [...existing, ...missingWorkflows.map((workflow) => workflowEntryFor(workflow)), ...missingAgents.map((agent) => workflowEntryFor(agent))],
    );

    return {
        added: [...missingWorkflows.map((workflow) => `workflows/${workflow.className}`), ...missingAgents.map((agent) => `workflows/${agent.className}`)],
        text: nextText,
    };
};

/**
 * Reconcile inferred Durable Object / D1 bindings into `wrangler.jsonc`.
 *
 * Writes only when something is missing; returns `changed: false` when the
 * config already satisfies the inferred needs.
 *
 * `environment`, when passed, does NOT change where this provisions — every
 * step below still only ADDS to the TOP-LEVEL config; wrangler's `env.<name>`
 * blocks have no auto-provisioning path today. The one write into the block is
 * {@link reconcileEnvQueues}, which retunes queue consumers the block already
 * declares and adds nothing. Otherwise it is used only to emit an
 * advisory warning, because bindings (`durable_objects`, `d1_databases`, …)
 * are non-inheritable (see `wrangler-environment.ts`'s `NON_INHERITABLE_KEYS`):
 * a `--env production` deploy needs its OWN copy of each one, and silently
 * writing only to the top level would leave that gap unmentioned. Extending
 * the JSONC writer itself to target `env.<name>.*` idempotently for every
 * binding kind here is a separate, larger change (each of the ~10 pipeline
 * steps below reads AND writes the top-level path) that this fix does not
 * attempt — `lunora deploy --env <name>` now VALIDATES the env-scoped view
 * (closing the reported gap), it just doesn't yet auto-provision it.
 */
const reconcileWranglerBindings = (projectRoot: string, inferred: InferredBindings, environment?: string): ReconcileBindingsResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    const exportGaps = collectExportGaps(inferred);

    if (!wranglerPath) {
        // No config to inspect — emit the raw capability hints unfiltered.
        return { added: [], changed: false, exportGaps, reason: "wrangler.jsonc not found", updated: [], warnings: collectWarnings(inferred, projectRoot) };
    }

    const { parsed, text: original } = readWranglerJsonc<WranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return {
            added: [],
            changed: false,
            exportGaps,
            reason: `failed to parse ${wranglerPath} as JSONC`,
            updated: [],
            warnings: collectWarnings(inferred, projectRoot),
            wranglerPath,
        };
    }

    // Hints are filtered against the existing config so a wired-up project is quiet.
    const warnings = collectWarnings(inferred, projectRoot, parsed);

    // See the doc comment above: auto-provisioning has no env-scoped write
    // path, so a `--env <name>` deploy is told plainly rather than silently
    // getting top-level-only bindings its non-inheritable ones won't reach.
    if (environment !== undefined) {
        const envBlockDeclared = parsed.env?.[environment] !== undefined;

        warnings.push(
            envBlockDeclared
                ? `auto-provisioned bindings are written to the top level of wrangler.jsonc only (queue consumers "env.${environment}" already declares are retuned, nothing is added) — "env.${environment}" has its own (non-inheritable) bindings and must be reconciled by hand; \`lunora deploy --env ${environment}\` now validates them, so a gap here will be reported at deploy time.`
                : `--env "${environment}" was requested but wrangler.jsonc declares no "env.${environment}" block — auto-provisioned bindings are written to the top level only and will not apply to that environment.`,
        );
    }

    // Only exported container classes are provisionable — wrangler rejects a
    // class_name the worker doesn't export. Their DO bindings + migration
    // classes ride through `reconcileDurableObjects` alongside the built-ins.
    const exportedContainers = inferred.containers.filter((container) => container.exported);
    // A voice-enabled agent's real-time session runs in a dedicated Durable
    // Object (unlike the durable loop, which compiles onto a Workflow). Each such
    // agent's generated `VoiceSessionDO` subclass therefore needs a
    // `durable_objects` binding + `new_sqlite_classes` migration, reconciled
    // through the same `reconcileDurableObjects` step as the built-ins and
    // containers. Non-voice agents add nothing here (they only touch
    // `workflows[]` via `exportedAgents`).
    const voiceAgents = inferred.agents.filter(
        (agent): agent is InferredAgent & { voiceBindingName: string; voiceClassName: string } =>
            agent.exported && agent.voice === true && agent.voiceBindingName !== undefined && agent.voiceClassName !== undefined,
    );
    const requiredDurableObjects: DurableObjectSpec[] = [
        ...inferred.durableObjects,
        ...exportedContainers.map((container) => {
            return { binding: container.bindingName, className: container.className };
        }),
        ...voiceAgents.map((agent) => {
            return { binding: agent.voiceBindingName, className: agent.voiceClassName };
        }),
    ];

    // Only exported workflow classes are provisionable — wrangler rejects a
    // class_name the worker doesn't export. Workflows are NOT Durable Objects,
    // so they get their own `workflows[]` step and never touch durable_objects
    // / migrations (no `requiredDurableObjects` entry, unlike containers).
    const exportedWorkflows = inferred.workflows.filter((workflow) => workflow.exported);
    // Agents compile onto Cloudflare Workflows, so their exported agent
    // WorkflowEntrypoint classes reconcile into the SAME `workflows[]` array
    // (via the single `reconcileWorkflows` step below — see its doc for why one
    // step must own that key). Same export gate as workflows.
    const exportedAgents = inferred.agents.filter((agent) => agent.exported);

    // Which queue consumer fields earlier passes wrote, so one taken out of
    // `defineQueue` can be taken back out of the config (see retuneConsumers).
    // The queue steps below fill `ownedScopes` with what THIS pass owns.
    const manifest = readManifest(projectRoot);
    const ownedTuning = readOwnedTuning(manifest, warnings);
    const ownedScopes: Record<string, OwnedTuning> = {};

    // The reconcile pipeline: each enabled step rewrites `text` but reads the
    // original `parsed`. This is only safe because the steps touch disjoint
    // top-level keys (durable_objects / migrations vs d1_databases vs ai vs
    // browser vs images vs analytics_engine_datasets vs worker_loaders vs containers /
    // observability vs workflows). A future step that depends on a key an
    // earlier step mutated must re-parse rather than reuse `parsed`.
    // Self-describing bindings (ai/browser/images/analytics) auto-write here;
    // their hint-only siblings (kv/hyperdrive/pipelines) carry an un-mintable
    // remote id and only surface as warnings (see collectWarnings).
    const pipeline: ReadonlyArray<{ enabled: boolean; run: (text: string) => ReconcileStep }> = [
        { enabled: true, run: (text) => reconcileDurableObjects(text, parsed, requiredDurableObjects) },
        { enabled: inferred.needsD1, run: (text) => reconcileD1(text, parsed) },
        { enabled: inferred.usesAi, run: (text) => reconcileSelfDescribing(text, parsed, "ai", "AI", "AI (Workers AI)") },
        { enabled: inferred.usesBrowser, run: (text) => reconcileSelfDescribing(text, parsed, "browser", "BROWSER", "BROWSER (Browser Rendering)") },
        { enabled: inferred.usesImages, run: (text) => reconcileSelfDescribing(text, parsed, "images", "IMAGES", "IMAGES (Cloudflare Images)") },
        { enabled: inferred.usesAnalytics, run: (text) => reconcileAnalytics(text, parsed) },
        { enabled: inferred.usesWorkerLoader, run: (text) => reconcileWorkerLoaders(text, parsed) },
        { enabled: true, run: (text) => reconcileObservability(text, parsed) },
        { enabled: exportedContainers.length > 0, run: (text) => reconcileContainers(text, parsed, exportedContainers) },
        {
            enabled: exportedWorkflows.length > 0 || exportedAgents.length > 0,
            run: (text) => reconcileWorkflows(text, parsed, exportedWorkflows, exportedAgents),
        },
        {
            enabled: inferred.queues.length > 0,
            run: (text) => {
                const step = reconcileQueues(text, parsed, inferred.queues, ownedTuning.queues ?? {});

                ownedScopes.queues = step.owned;

                return step;
            },
        },
        ...(environment === undefined || parsed.env?.[environment] === undefined
            ? []
            : [
                  {
                      enabled: inferred.queues.length > 0,
                      run: (text: string) => {
                          const scope = `env.${environment}.queues`;
                          const step = reconcileEnvQueues(text, parsed, inferred.queues, environment, ownedTuning[scope] ?? {});

                          ownedScopes[scope] = step.owned;

                          return step;
                      },
                  },
              ]),
    ];

    let text = original;
    const added: string[] = [];
    const updated: string[] = [];

    for (const step of pipeline) {
        if (!step.enabled) {
            continue;
        }

        const result = step.run(text);

        text = result.text;
        added.push(...result.added);
        updated.push(...(result.updated ?? []));
        warnings.push(...(result.warnings ?? []));
    }

    // Ownership is recorded only once the config it describes is on disk, never
    // before: a record ahead of the file would let the next pass remove a field
    // this one never managed to write.
    const recordOwnership = (wranglerWritten: boolean): void => {
        if (manifest === undefined || Object.keys(ownedScopes).length === 0) {
            return;
        }

        // Its own failure, not the caller's "binding inference skipped": the
        // config change it describes may already be on disk.
        try {
            recordOwnedTuning(manifest, ownedTuning, ownedScopes);
        } catch (error: unknown) {
            warnings.push(
                `${wranglerWritten ? "wrangler.jsonc was updated, but " : ""}recording the queue tuning reconcile owns in ${manifest.path} (lunora.queueTuning) failed: ${error instanceof Error ? error.message : String(error)}. Until it is recorded, an option removed from defineQueue stays deployed.`,
            );
        }
    };

    // A freshly-written DB binding carries a placeholder id; surface it so the
    // user runs `wrangler d1 create` before the deploy reaches wrangler (which
    // would otherwise fail late on the literal placeholder). `reconcileD1` is the
    // only step that emits this label.
    if (added.includes("DB (D1)")) {
        warnings.push(
            `wrote a DB binding with a placeholder database_id ("${D1_PLACEHOLDER_ID}") — run \`wrangler d1 create <name>\` and replace it before deploying.`,
        );
    }

    if (text === original) {
        recordOwnership(false);

        return { added: [], changed: false, exportGaps, reason: "bindings already in sync", updated: [], warnings, wranglerPath };
    }

    writeFileSync(wranglerPath, text, "utf8");
    recordOwnership(true);

    return { added, changed: true, exportGaps, updated, warnings, wranglerPath };
};

export type { ExportGap, ReconcileBindingsResult };
export { collectExportGaps, reconcileWranglerBindings };
