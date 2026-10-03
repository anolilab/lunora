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
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { DefaultScheduledContainerIR, DurableObjectScheduledContainerIR } from "@lunora/codegen";
import { containerBuildTag } from "@lunora/container";

import type { InferredAgent, InferredBindings, InferredContainer, InferredWorkflow } from "../infer-bindings";
import { applyModify } from "../jsonc-edit";
import type { DurableObjectSpec, GeneratedClassModule } from "../worker-entry";
import type { Manifest } from "./lunora-manifest";
import { readManifest } from "./lunora-manifest";
import type { OwnedTuning } from "./reconcile-queues";
import { readOwnedTuning, reconcileEnvQueues, reconcileQueues, recordOwnedTuning } from "./reconcile-queues";
import type { OwnedServices } from "./reconcile-services";
import { readOwnedServices, reconcileDevConfigServices, reconcileServices, recordOwnedServices } from "./reconcile-services";
import collectWarnings from "./reconcile-warnings";
import { objectBindingEntries, stringEntries } from "./validate-bindings";
import { scanAppChains } from "./worker-entry-checks";
import { settingLeaf, WORKFLOW_SETTING_KEYS, WORKFLOW_SETTINGS, workflowSettingsFor } from "./workflow-settings";
import { DEFAULT_OBSERVABILITY } from "./wrangler-config";
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

    /** What was written to the SvelteKit / Nuxt dev sidecar's own config, when anything was. */
    devConfig?: { added: string[]; path: string; updated: string[] };

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
 * The self-describing single-`{ binding }` sections reconcile auto-writes:
 * wrangler key → the binding name it writes and the label it reports. They share
 * one shape — the binding name is the whole config, with no remote id to mint —
 * so {@link reconcileSelfDescribing} covers all of them, and its key type is
 * this table's keys.
 */
const SELF_DESCRIBING_BINDINGS = {
    ai: { binding: "AI", label: "AI (Workers AI)" },
    analytics: { binding: "ANALYTICS_SQL", label: "ANALYTICS_SQL (Analytics SQL)" },
    browser: { binding: "BROWSER", label: "BROWSER (Browser Rendering)" },
    images: { binding: "IMAGES", label: "IMAGES (Cloudflare Images)" },
} as const satisfies Partial<Record<keyof WranglerShape, { binding: string; label: string }>>;

/**
 * Add one {@link SELF_DESCRIBING_BINDINGS} section if absent, written safely
 * like `DB`. Idempotent on `parsed[key].binding`. Pure.
 */
const reconcileSelfDescribing = (text: string, parsed: WranglerShape, key: keyof typeof SELF_DESCRIBING_BINDINGS): ReconcileStep => {
    const { binding, label } = SELF_DESCRIBING_BINDINGS[key];
    const current = parsed[key]?.binding;

    if (typeof current === "string" && current.length > 0) {
        return { added: [], text };
    }

    return { added: [label], text: applyModify(text, [key], { binding }) };
};

/**
 * Whether reconcile should write the `analytics` binding: `ctx.analyticsSql` is
 * read and the project does NOT chain `.analyticsSql(...)` onto `defineApp()`.
 * The chain is a parsed call anywhere in the project ({@link scanAppChains}), so
 * a comment or string naming it does not count. With the override,
 * `ctx.analyticsSql` reads whatever it returns (typically the REST transport),
 * so the binding would be dead config. A project with no readable `defineApp()`
 * composition reads as not overridden: the binding is then what
 * `ctx.analyticsSql` reads by default.
 */
const wantsAnalyticsSqlBinding = (inferred: InferredBindings, projectRoot: string): boolean =>
    inferred.usesAnalyticsSql && scanAppChains(projectRoot, new Set(["analyticsSql"]))?.chained.has("analyticsSql") !== true;

/** Sections that are a list of entries naming their binding with `name`, not `binding`. */
const NAME_KEYED_LIST_SECTIONS = new Set(["ratelimits", "send_email"]);

/** Sections whose `bindings` list names each entry with `name`. */
const NESTED_NAME_BINDING_SECTIONS = ["durable_objects", "logfwdr", "unsafe"] as const;

/** Sections whose object KEYS are the binding names. */
const KEYED_MAP_SECTIONS = new Set(["data_blobs", "text_blobs", "vars", "wasm_modules"]);

/** A plain (non-array) object. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const bindsName = (entry: unknown, field: string, name: string): boolean => isRecord(entry) && entry[field] === name;

/** Whether one top-level section's own value (object, list, or keyed map) binds `name`. */
const sectionBindsName = (section: string, value: unknown, name: string): boolean => {
    if (KEYED_MAP_SECTIONS.has(section)) {
        return isRecord(value) && Object.hasOwn(value, name);
    }

    const field = NAME_KEYED_LIST_SECTIONS.has(section) ? "name" : "binding";

    return Array.isArray(value) ? value.some((entry) => bindsName(entry, field, name)) : bindsName(value, "binding", name);
};

/**
 * Where `name` is already bound in the top-level config, as `section` (or
 * `section.sub`), else `undefined`. Covers every entry shape wrangler binds a
 * name with: a `{ binding }` object (`ai`, `browser`, …), a list of
 * `{ binding }` entries (`kv_namespaces`, `services`, `ai_search`, …), a list
 * of `{ name }` entries (`ratelimits`, `send_email`), a `bindings[].name` list
 * (`durable_objects`, `unsafe`, `logfwdr`), `queues.producers[].binding`, the
 * keys of `vars` / `wasm_modules` / `text_blobs` / `data_blobs`, and the
 * declared `secrets.required`. `env.*` blocks are skipped: they are separate
 * workers' configs as far as name clashes go.
 */
const bindingNameOwner = (parsed: WranglerShape, name: string): string | undefined => {
    const config = parsed as Record<string, unknown>;
    const owner = Object.entries(config).find(([section, value]) => section !== "env" && sectionBindsName(section, value, name));

    if (owner !== undefined) {
        return owner[0];
    }

    for (const section of NESTED_NAME_BINDING_SECTIONS) {
        const block = config[section];

        if (isRecord(block) && Array.isArray(block.bindings) && block.bindings.some((entry) => bindsName(entry, "name", name))) {
            return `${section}.bindings`;
        }
    }

    if (parsed.queues?.producers?.some((entry) => entry.binding === name) === true) {
        return "queues.producers";
    }

    const required = parsed.secrets?.required;

    if (Array.isArray(required) && required.includes(name)) {
        return "secrets.required";
    }

    return undefined;
};

/**
 * The array twin of {@link reconcileSelfDescribing}: add a self-describing
 * binding whose wrangler key holds a LIST, as a one-entry array, when the key
 * has no entry at all. Idempotent on ANY existing entry — an app that binds its
 * own resource under another name keeps it (pointing the `defineApp()` override
 * at it), and a second, unused binding is never added beside it. Pure.
 *
 * Skipped, with a warning instead, when the entry's binding name is already
 * taken by another section (`ANALYTICS` as a KV namespace, `AI_SEARCH` as an
 * `ai_search` instance, …): writing it would make wrangler reject the config
 * with "assigned to multiple bindings".
 *
 * - `analytics_engine_datasets` (`@lunora/bindings/analytics` usage) is written
 * as `{ binding: "ANALYTICS", dataset: "ANALYTICS" }`: the dataset is created
 * lazily on first write (no remote id to mint), and defaults to the binding name
 * on Cloudflare's side — written explicitly to avoid drift.
 * - `ai_search_namespaces` (`ctx.aiSearch` reads) is written as
 * `{ binding: "AI_SEARCH", namespace: "default" }`: `default` exists on every
 * account and wrangler creates a missing namespace on deploy. No `remote: true`
 * either — wrangler rates the binding "never has a local simulator" and proxies
 * it remotely in plain `wrangler dev`, exactly like `ai`.
 */
const reconcileSelfDescribingArray = (
    text: string,
    parsed: WranglerShape,
    key: "ai_search_namespaces" | "analytics_engine_datasets",
    entry: Readonly<Record<string, string>> & { binding: string },
    label: string,
): ReconcileStep => {
    if ((parsed[key]?.length ?? 0) > 0) {
        return { added: [], text };
    }

    const owner = bindingNameOwner(parsed, entry.binding);

    if (owner !== undefined) {
        return {
            added: [],
            text,
            warnings: [
                `${key}: not adding ${JSON.stringify(entry)} — the name "${entry.binding}" is already bound by \`${owner}\` in wrangler.jsonc. Add a ${key} entry under another binding name and point the matching \`defineApp()\` override at it.`,
            ],
        };
    }

    return { added: [label], text: applyModify(text, [key], [entry]) };
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
const imageRefFor = (container: DefaultScheduledContainerIR): string => {
    const { image } = container;

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
const durableObjectContainerEntryFor = (container: DurableObjectScheduledContainerIR): Record<string, unknown> => {
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
    if (container.schedulingPolicy === "durable_object") {
        return durableObjectContainerEntryFor(container);
    }

    const { image } = container;

    const entry: Record<string, unknown> = {
        class_name: container.className,
        image: imageRefFor(container),
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
    // Append first, retune second, as for workflows: the append rewrites the
    // array from `parsed`, and never moves an existing entry's index.
    let nextText = missing.length === 0 ? text : applyModify(text, ["containers"], [...existing, ...missing.map((container) => containerEntryFor(container))]);
    const updated: string[] = [];
    const warnings: string[] = [];

    for (const [index, entry] of existing.entries()) {
        const container = containers.find((candidate) => candidate.className === entry.class_name);

        if (container === undefined) {
            continue;
        }

        const declared = container.schedulingPolicy ?? "default";

        // The policy is immutable on Cloudflare — switching means a new container
        // application — so it is flagged, never rewritten in place.
        if ((entry.scheduling_policy ?? "default") !== declared) {
            warnings.push(
                `containers/${container.className} has scheduling_policy "${entry.scheduling_policy ?? "default"}" in wrangler.jsonc but defineContainer "${container.exportName}" declares "${declared}" — the policy is immutable, so replace the entry (and its container application) by hand.`,
            );

            continue;
        }

        // Named images are the part of a `durable_object` entry the app keeps
        // editing, and a missing one fails `start({ image })` at runtime.
        const images = container.schedulingPolicy === "durable_object" ? durableObjectContainerEntryFor(container).images : undefined;

        if (images !== undefined && JSON.stringify(entry.images) !== JSON.stringify(images)) {
            nextText = applyModify(nextText, ["containers", index, "images"], images);
            updated.push(`containers/${container.className}.images`);
        }
    }

    return { added: missing.map((container) => `containers/${container.className}`), text: nextText, updated, warnings };
};

/**
 * Switch Workers Observability on when the key is entirely absent, so every
 * Lunora worker ships with Workers Logs + Traces enabled by default (not just
 * container apps), writing {@link DEFAULT_OBSERVABILITY}: `head_sampling_rate: 1`
 * keeps all logs initially — a sensible default users can dial down. An explicit `enabled: false` is a user billing
 * decision and is left untouched (`collectWarnings` flags the container case).
 * Pure.
 */
const reconcileObservability = (text: string, parsed: WranglerShape): ReconcileStep => {
    if (parsed.observability !== undefined) {
        return { added: [], text };
    }

    const nextText = applyModify(text, ["observability"], { ...DEFAULT_OBSERVABILITY });

    return { added: ["observability"], text: nextText };
};

/**
 * The oldest toolchain that declares and runs Workflows in `exports`: wrangler
 * 4.142.0 and `@cloudflare/vite-plugin` 1.61.0. An older one ignores the field,
 * so moving a `workflows[]` binding into `exports` under it unregisters the
 * workflow.
 */
const WORKFLOW_EXPORTS_TOOLCHAIN: ReadonlyArray<{ minimum: readonly [number, number]; name: string }> = [
    { minimum: [4, 142], name: "wrangler" },
    { minimum: [1, 61], name: "@cloudflare/vite-plugin" },
];

/** The `pnpm add -D` arguments that lift every package in {@link WORKFLOW_EXPORTS_TOOLCHAIN} past its floor. */
const WORKFLOW_EXPORTS_UPGRADE: string = WORKFLOW_EXPORTS_TOOLCHAIN.map(({ minimum, name }) => `${name}@^${minimum.join(".")}.0`).join(" ");

/** The installed `major.minor` of `name` as resolved from the project, or `undefined` when it is not installed. */
const installedVersion = (projectRoot: string, name: string): readonly [number, number] | undefined => {
    try {
        const manifest = createRequire(join(projectRoot, "package.json")).resolve(`${name}/package.json`);
        const [major = 0, minor = 0] = String((JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version)
            .split(".")
            .map(Number);

        return [major, minor];
    } catch {
        return undefined;
    }
};

/** A warning naming each installed toolchain package too old for workflow `exports`, or `undefined` when none is. */
const workflowExportsToolchainGap = (projectRoot: string): string | undefined => {
    const stale = WORKFLOW_EXPORTS_TOOLCHAIN.flatMap(({ minimum, name }) => {
        const version = installedVersion(projectRoot, name);

        return version !== undefined && (version[0] < minimum[0] || (version[0] === minimum[0] && version[1] < minimum[1]))
            ? [`${name} ${version.join(".")} (needs >= ${minimum.join(".")})`]
            : [];
    });

    return stale.length === 0
        ? undefined
        : `workflows are declared in wrangler \`exports\`, which ${stale.join(" and ")} cannot run — reconcile left workflows[] untouched. Upgrade (\`pnpm add -D ${WORKFLOW_EXPORTS_UPGRADE}\`) and re-run.`;
};

/**
 * Environment blocks are not rewritten (no reconcile step writes into them), so
 * a `workflows[]` in one keeps bindings the runtime no longer reads — named here.
 */
const environmentWorkflowWarnings = (parsed: WranglerShape): string[] =>
    Object.entries(parsed.env ?? {}).flatMap(([environment, block]) =>
        Array.isArray((block as { workflows?: unknown } | null)?.workflows)
            ? [
                  `env.${environment}.workflows declares workflow bindings, but Lunora now declares workflows in \`exports\` and resolves them on ctx.exports — move them to that environment's own \`exports\` by hand.`,
              ]
            : [],
    );

/**
 * Bring each EXISTING `exports.<Class>` workflow entry a `defineWorkflow` export
 * generates in line with the settings it declares: a declared leaf that differs
 * is written at its own path (so comments elsewhere in the entry survive). A
 * leaf the export does not declare but the entry carries is left alone and
 * reported: without an ownership record, a setting since removed from
 * `defineWorkflow` and one set by hand look the same, and deleting the second is
 * the worse mistake — but a stale `schedules` keeps starting instances, so it is
 * named.
 */
const retuneWorkflowExports = (
    text: string,
    exported: NonNullable<WranglerShape["exports"]>,
    workflows: ReadonlyArray<InferredWorkflow>,
): { text: string; updated: string[]; warnings: string[] } => {
    let nextText = text;
    const updated: string[] = [];
    const warnings: string[] = [];

    for (const workflow of workflows) {
        const entry = exported[workflow.className];

        if (entry?.type !== "workflow") {
            continue;
        }

        for (const { of, path } of WORKFLOW_SETTINGS) {
            const value = of(workflow);
            const current = settingLeaf(entry, path);
            const label = `exports/${workflow.className}.${path.join(".")}`;

            if (value === undefined) {
                if (current !== undefined) {
                    warnings.push(
                        `${label} is set in wrangler.jsonc but defineWorkflow "${workflow.exportName}" does not declare it — reconcile leaves it in place. Remove it by hand if it was dropped from the definition.`,
                    );
                }

                continue;
            }

            if (JSON.stringify(current) !== JSON.stringify(value)) {
                nextText = applyModify(nextText, ["exports", workflow.className, ...path], value);
                updated.push(label);
            }
        }
    }

    return { text: nextText, updated, warnings };
};

/**
 * Declare every `defineWorkflow` and `defineAgent` export as a wrangler
 * `exports.<Class>` workflow (`{ type: "workflow", name, …settings }`), which the
 * runtime reaches through `ctx.exports.<Class>` — no `workflows[]` binding. One
 * step owns both keys (the reconcile pipeline's disjoint-key invariant): it
 * adds the missing export entries (matched by class name), and MOVES a
 * `workflows[]` binding for a declared class that this worker defines (no
 * `script_name`) into its export. Cloudflare shares instances between a binding
 * and an export of the same `name`, so the move keeps every running instance.
 * Workflows and agents are NOT Durable Objects, so nothing else is written. An
 * existing export has its declared settings brought in line by
 * {@link retuneWorkflowExports}.
 *
 * Add-only for classes nothing declares: an entry whose class no declaration
 * generates is left in place and reported by `orphanedEntryWarnings`
 * (`reconcile-warnings.ts`) instead — see there for why removal needs ownership
 * this file cannot establish. Pure.
 */
const reconcileWorkflows = (
    text: string,
    parsed: WranglerShape,
    workflows: ReadonlyArray<InferredWorkflow>,
    agents: ReadonlyArray<InferredAgent>,
    toolchainGap: string | undefined,
): ReconcileStep => {
    if (toolchainGap !== undefined) {
        return { added: [], text, warnings: [toolchainGap] };
    }

    // Agents declare no deploy settings; only a `defineWorkflow` contributes any.
    const declared: ReadonlyArray<{ settings: Record<string, unknown>; workflow: InferredAgent | InferredWorkflow }> = [
        ...workflows.map((workflow) => {
            return { settings: workflowSettingsFor(workflow), workflow };
        }),
        ...agents.map((agent) => {
            return { settings: {}, workflow: agent };
        }),
    ];
    const declaredClasses = new Set(declared.map(({ workflow }) => workflow.className));
    const bindings = parsed.workflows ?? [];
    const moved = bindings.filter((entry) => entry.script_name === undefined && entry.class_name !== undefined && declaredClasses.has(entry.class_name));
    const exported = parsed.exports ?? {};
    const added: string[] = [];
    const updated: string[] = [];
    const warnings: string[] = [];
    let nextText = text;

    for (const { settings, workflow } of declared) {
        if (exported[workflow.className] !== undefined && exported[workflow.className] !== null) {
            continue;
        }

        const binding = moved.find((entry) => entry.class_name === workflow.className);
        // Settings set by hand on the binding move with it; the declaration's own win.
        const carried = Object.fromEntries(
            WORKFLOW_SETTING_KEYS.flatMap((key) => {
                const value = settingLeaf(binding, [key]);

                return value === undefined ? [] : [[key, value]];
            }),
        );
        // A moved binding keeps its DEPLOYED name: Cloudflare keys a workflow's
        // instances by name, so taking the declaration's instead would start a
        // new, empty workflow and orphan every running instance.
        const name = binding?.name ?? workflow.name;

        if (binding?.name !== undefined && binding.name !== workflow.name) {
            warnings.push(
                `workflows/${workflow.className} is deployed as "${binding.name}" but declared as "${workflow.name}" — its export keeps "${binding.name}" so running instances survive. Change the declaration to match, or rename deliberately (it starts a new, empty workflow).`,
            );
        }

        nextText = applyModify(nextText, ["exports", workflow.className], { type: "workflow", ...carried, ...settings, name });
        (binding === undefined ? added : updated).push(`exports/${workflow.className}`);
    }

    // Drop the moved bindings last: rewriting the array from `parsed` never
    // touches `exports`, and an emptied array goes rather than lingering as `[]`.
    if (moved.length > 0) {
        const remaining = bindings.filter((entry) => !moved.includes(entry));

        nextText = applyModify(nextText, ["workflows"], remaining.length === 0 ? undefined : remaining);
        updated.push(...moved.map((entry) => `workflows/${String(entry.class_name)} → exports`));
    }

    warnings.push(...environmentWorkflowWarnings(parsed));

    const retune = retuneWorkflowExports(nextText, exported, workflows);

    return { added, text: retune.text, updated: [...updated, ...retune.updated], warnings: [...warnings, ...retune.warnings] };
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
    // `exports` via `exportedAgents`).
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
    // so they get their own `exports` step and never touch durable_objects
    // / migrations (no `requiredDurableObjects` entry, unlike containers).
    const exportedWorkflows = inferred.workflows.filter((workflow) => workflow.exported);
    // Agents compile onto Cloudflare Workflows, so their exported agent
    // WorkflowEntrypoint classes reconcile into the SAME `exports` map (via the
    // single `reconcileWorkflows` step below — see its doc for why one step must
    // own that key). Same export gate as workflows.
    const exportedAgents = inferred.agents.filter((agent) => agent.exported);

    // Which queue consumer fields earlier passes wrote, so one taken out of
    // `defineQueue` can be taken back out of the config (see retuneConsumers).
    // The queue steps below fill `ownedScopes` with what THIS pass owns.
    const manifest = readManifest(projectRoot);
    const ownedTuning = readOwnedTuning(manifest, warnings);
    const ownedScopes: Record<string, OwnedTuning> = {};
    const ownedServicesRecord = readOwnedServices(manifest);
    let ownedServices: OwnedServices | undefined;

    // The reconcile pipeline: each enabled step rewrites `text` but reads the
    // original `parsed`. This is only safe because the steps touch disjoint
    // top-level keys (durable_objects / migrations vs d1_databases vs ai vs
    // ai_search_namespaces vs analytics vs browser vs images vs analytics_engine_datasets vs worker_loaders vs containers /
    // observability vs exports + workflows vs queues vs services + env.*.services;
    // the env queue step writes only env.<name>.queues). A future step that depends on a key an
    // earlier step mutated must re-parse rather than reuse `parsed`.
    // Self-describing bindings (SELF_DESCRIBING_BINDINGS, plus the array-shaped
    // ai_search_namespaces and analytics_engine_datasets) auto-write here;
    // their hint-only siblings (kv/hyperdrive/pipelines) carry an un-mintable
    // remote id and only surface as warnings (see collectWarnings).
    const pipeline: ReadonlyArray<{ enabled: boolean; run: (text: string) => ReconcileStep }> = [
        { enabled: true, run: (text) => reconcileDurableObjects(text, parsed, requiredDurableObjects) },
        { enabled: inferred.needsD1, run: (text) => reconcileD1(text, parsed) },
        { enabled: inferred.usesAi, run: (text) => reconcileSelfDescribing(text, parsed, "ai") },
        {
            enabled: inferred.usesAiSearch,
            run: (text) =>
                reconcileSelfDescribingArray(
                    text,
                    parsed,
                    "ai_search_namespaces",
                    { binding: "AI_SEARCH", namespace: "default" },
                    "AI_SEARCH (AI Search namespace)",
                ),
        },
        // No `remote: true`: wrangler rates the Analytics SQL binding as never
        // having a local simulator and proxies it remotely in plain dev, like `ai`.
        // Skipped when the app points `ctx.analyticsSql` elsewhere with
        // `defineApp().analyticsSql(...)` (the REST transport, typically): the
        // binding would then be dead config that wrangler < 4.145.0 rejects.
        {
            enabled: wantsAnalyticsSqlBinding(inferred, projectRoot),
            run: (text) => reconcileSelfDescribing(text, parsed, "analytics"),
        },
        { enabled: inferred.usesBrowser, run: (text) => reconcileSelfDescribing(text, parsed, "browser") },
        { enabled: inferred.usesImages, run: (text) => reconcileSelfDescribing(text, parsed, "images") },
        {
            enabled: inferred.usesAnalytics,
            run: (text) =>
                reconcileSelfDescribingArray(
                    text,
                    parsed,
                    "analytics_engine_datasets",
                    { binding: "ANALYTICS", dataset: "ANALYTICS" },
                    "ANALYTICS (Analytics Engine)",
                ),
        },
        { enabled: inferred.usesWorkerLoader, run: (text) => reconcileWorkerLoaders(text, parsed) },
        { enabled: true, run: (text) => reconcileObservability(text, parsed) },
        { enabled: exportedContainers.length > 0, run: (text) => reconcileContainers(text, parsed, exportedContainers) },
        {
            enabled: exportedWorkflows.length > 0 || exportedAgents.length > 0,
            run: (text) => reconcileWorkflows(text, parsed, exportedWorkflows, exportedAgents, workflowExportsToolchainGap(projectRoot)),
        },
        {
            enabled: inferred.queues.length > 0,
            run: (text) => {
                const step = reconcileQueues(text, parsed, inferred.queues, ownedTuning.queues ?? {});

                ownedScopes.queues = step.owned;

                return step;
            },
        },
        {
            // Also runs with nothing declared, so an owned entry goes once its declaration does.
            // Skipped when the declaration is unreadable: reconciling against "none"
            // would strip every owned entry over a typo.
            enabled: inferred.services !== undefined && (inferred.services.length > 0 || Object.keys(ownedServicesRecord).length > 0),
            run: (text) => {
                const step = reconcileServices(text, parsed, inferred.services ?? [], ownedServicesRecord);

                ownedServices = step.owned;

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
        if (manifest === undefined) {
            return;
        }

        const servicesOwned = ownedServices;
        const records = [
            ...(Object.keys(ownedScopes).length > 0
                ? [
                      {
                          consequence: "an option removed from defineQueue stays deployed",
                          key: "queueTuning",
                          label: "queue tuning",
                          write: (current: Manifest) => {
                              recordOwnedTuning(current, ownedTuning, ownedScopes);
                          },
                      },
                  ]
                : []),
            ...(servicesOwned === undefined
                ? []
                : [
                      {
                          consequence: "a service removed from lunora.config stays bound",
                          key: "services",
                          label: "service bindings",
                          write: (current: Manifest) => {
                              recordOwnedServices(current, servicesOwned);
                          },
                      },
                  ]),
        ];

        for (const record of records) {
            // Its own failure, not the caller's "binding inference skipped": the
            // config change it describes may already be on disk.
            try {
                // Re-read per record: each write starts from the file as the last
                // one left it, or the second would drop the key the first wrote.
                record.write(readManifest(projectRoot) ?? manifest);
            } catch (error: unknown) {
                warnings.push(
                    `${wranglerWritten ? "wrangler.jsonc was updated, but " : ""}recording the ${record.label} reconcile owns in ${manifest.path} (lunora.${record.key}) failed: ${error instanceof Error ? error.message : String(error)}. Until it is recorded, ${record.consequence}.`,
                );
            }
        }
    };

    // The SvelteKit / Nuxt dev sidecar runs its own `wrangler.dev.jsonc`; its
    // worker hosts the actions, so it gets the same service bindings. Same
    // skip-when-unreadable rule as the step above.
    let devConfig: ReconcileBindingsResult["devConfig"];

    if (inferred.services !== undefined) {
        const devStep = reconcileDevConfigServices(projectRoot, inferred.services, ownedServicesRecord);

        warnings.push(...devStep.warnings);
        ownedServices = { ...ownedServices, ...devStep.owned };
        devConfig = devStep.added.length > 0 || devStep.updated.length > 0 ? { added: devStep.added, path: devStep.path, updated: devStep.updated } : undefined;
    }

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

        return { added, changed: false, devConfig, exportGaps, reason: "bindings already in sync", updated, warnings, wranglerPath };
    }

    writeFileSync(wranglerPath, text, "utf8");
    recordOwnership(true);

    return { added, changed: true, devConfig, exportGaps, updated, warnings, wranglerPath };
};

export type { ExportGap, ReconcileBindingsResult };
export { collectExportGaps, reconcileWranglerBindings };
