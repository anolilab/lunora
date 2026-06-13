/**
 * Write the bindings implied by `inferCirrusBindings` into the project's
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

import { containerBuildTag } from "@cirrus/container";
import { applyEdits, modify } from "jsonc-parser";

import type { DurableObjectSpec, InferredBindings, InferredContainer } from "./infer-bindings";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 4 } } as const;

/**
 * Placeholder `database_id` written for an auto-provisioned `DB` binding. It is
 * intentionally not a valid id so a deploy can't silently target the wrong
 * database; reconciliation warns the user to replace it (see the D1 warning in
 * `reconcileWranglerBindings`).
 */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

interface DurableObjectBinding {
    class_name?: string;
    name?: string;
}

interface MigrationEntry {
    new_classes?: ReadonlyArray<string>;
    new_sqlite_classes?: ReadonlyArray<string>;
    tag?: string;
}

interface ContainerEntry {
    class_name?: string;
}

interface WranglerShape {
    ai?: { binding?: string };
    containers?: ReadonlyArray<ContainerEntry>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<DurableObjectBinding> };
    migrations?: ReadonlyArray<MigrationEntry>;
    name?: string;
    observability?: { enabled?: boolean };
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
}

interface ReconcileBindingsResult {
    /** Short labels for each binding written (e.g. `"SCHEDULER/SchedulerDO"`). */
    added: string[];
    /** `true` when `wrangler.jsonc` was rewritten. */
    changed: boolean;
    /** Reason reconciliation was skipped, for logging. */
    reason?: string;
    /** Non-fatal hints for capabilities that cannot be auto-provisioned. */
    warnings: string[];
    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

interface ReconcileStep {
    added: string[];
    text: string;
}

/**
 * Hints for capabilities used but not safely auto-provisionable — only emitted
 * when the corresponding binding is actually **missing**. `parsed` (the existing
 * `wrangler.jsonc`, when one was read) suppresses a hint whose binding is already
 * configured, so a correctly-wired project starts the dev server clean.
 *
 * Storage is silent once any `r2_buckets` binding exists (cirrus can't pick the bucket name, but if one is already declared there's nothing to add). Auth is silent once sessions have a store — a `DB` D1 binding (the default, D1-backed) or an exported `SessionDO` (DO-backed); only a project with neither has nowhere to put sessions, so only that case warns. Scheduler keys on the `SchedulerDO` export, the safe binding signal. Payment has no binding at all — state rides the app's existing `ShardDO` via `ctx.db`; its only need is the provider secret pair, which lives in `.dev.vars` (not `wrangler.jsonc`), so the reminder fires whenever payment is used and nothing here can confirm it away.
 */
const collectWarnings = (inferred: InferredBindings, parsed?: WranglerShape): string[] => {
    const exported = new Set(inferred.durableObjects.map((object) => object.className));
    const warnings: string[] = [];

    const hasR2Bucket = (parsed?.r2_buckets?.length ?? 0) > 0;
    // A `DB` binding already present, or a `.global()` schema that will have one
    // reconciled in, means D1-backed sessions are viable.
    const hasSessionStore = (parsed?.d1_databases?.some((binding) => binding.binding === "DB") ?? false) || inferred.needsD1;

    if (inferred.usesStorage && !hasR2Bucket) {
        warnings.push(
            "@cirrus/storage is used but R2 bucket bindings have user-defined names; add an r2_buckets entry and pass env.<BINDING> to createStorage().",
        );
    }

    if (inferred.usesAuth && !exported.has("SessionDO") && !hasSessionStore) {
        warnings.push(
            "@cirrus/auth is used but the worker entry exports no SessionDO; sessions are D1-backed, or export SessionDO to enable DO-backed sessions.",
        );
    }

    if (inferred.usesScheduler && !exported.has("SchedulerDO")) {
        warnings.push("@cirrus/scheduler is used but the worker entry exports no SchedulerDO; export it so the SCHEDULER binding can be provisioned.");
    }

    for (const container of inferred.containers) {
        if (!container.exported) {
            warnings.push(
                `container "${container.exportName}" is declared but ${container.className} is not exported by the worker entry; add \`export * from "./cirrus/_generated/containers"\` so its binding can be provisioned.`,
            );
        }
    }

    // Container logs are invisible without Workers observability. An absent key
    // is reconciled to enabled below; an explicit `false` is a user billing
    // decision we respect — but flag, since it silently swallows container logs.
    if (inferred.containers.length > 0 && parsed?.observability?.enabled === false) {
        warnings.push("containers are declared but observability is explicitly disabled in wrangler.jsonc — container logs will not be captured.");
    }

    if (inferred.usesPayment) {
        // Payment state rides the app's existing ShardDO via ctx.db, so there is
        // no wrangler binding to provision — only the provider secrets, which
        // live in .dev.vars (not wrangler.jsonc) and the scaffolder can't
        // fabricate. We always remind, since wrangler.jsonc can't confirm them.
        warnings.push(
            "@cirrus/payment is used; set the provider secrets in .dev.vars — STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Stripe) or POLAR_ACCESS_TOKEN + POLAR_WEBHOOK_SECRET (Polar).",
        );
    }

    return warnings;
};

/** Apply one structural edit and return the rewritten text. */
const applyModify = (text: string, path: ReadonlyArray<number | string>, value: unknown): string => {
    const edits = modify(text, [...path], value, FORMATTING);

    return edits.length > 0 ? applyEdits(text, edits) : text;
};

/** Compute the lowest free `vN` `migrations` tag (`v1`, `v2`, …). */
const nextMigrationTag = (migrations: ReadonlyArray<MigrationEntry>): string => {
    const used = new Set(migrations.map((migration) => migration.tag));
    let index = 1;

    while (used.has(`v${String(index)}`)) {
        index += 1;
    }

    return `v${String(index)}`;
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
    const registered = new Set(migrations.flatMap((migration) => [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]));
    const missingClasses = required.map((object) => object.className).filter((className) => !registered.has(className));

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

    const databaseName = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : "cirrus";
    const nextD1 = [...d1Bindings, { binding: "DB", database_id: D1_PLACEHOLDER_ID, database_name: databaseName }];

    return { added: ["DB (D1)"], text: applyModify(text, ["d1_databases"], nextD1) };
};

/**
 * Add the `ai` Workers AI binding for `@cirrus/ai` / `env.AI` usage, if absent.
 * Unlike R2 (user-defined bucket name), the binding is parameterless —
 * `{ "binding": "AI" }` — so it can be written safely like `DB`. Pure.
 */
const reconcileAi = (text: string, parsed: WranglerShape): ReconcileStep => {
    if (typeof parsed.ai?.binding === "string" && parsed.ai.binding.length > 0) {
        return { added: [], text };
    }

    return { added: ["AI (Workers AI)"], text: applyModify(text, ["ai"], { binding: "AI" }) };
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

/** The wrangler `containers[].image` for an inferred container. */
const imageRefFor = (container: InferredContainer): string => {
    if (container.image.kind === "dockerfile") {
        return container.image.dockerfilePath;
    }

    if (container.image.kind === "registry") {
        return container.image.reference;
    }

    // A Railpack `{ build }` source: `cirrus deploy` builds + pushes this local
    // tag (derived from the export name) before wrangler runs, so wrangler.jsonc
    // references the pushed tag. See `containerBuildTag`.
    return containerBuildTag(container.exportName);
};

/** Render one wrangler `containers[]` entry from an inferred container. Pure. */
const containerEntryFor = (container: InferredContainer): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
        class_name: container.className,
        image: imageRefFor(container),
    };

    if (container.image.kind === "dockerfile") {
        entry.image_build_context = container.image.buildContext;
    }

    // Build args (image_vars) only make sense for an image cirrus builds.
    if (container.buildArgs !== undefined && container.image.kind !== "registry") {
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
 * Add any missing `containers[]` entries (matched by `class_name`) and switch
 * `observability` on when the key is entirely absent — container logs are
 * invisible without it, but an explicit `enabled: false` is a user billing
 * decision and is left untouched (`collectWarnings` flags it instead). The
 * Durable Object bindings + migration classes for containers ride through
 * `reconcileDurableObjects` with the built-in DOs. Pure.
 */
const reconcileContainers = (text: string, parsed: WranglerShape, containers: ReadonlyArray<InferredContainer>): ReconcileStep => {
    const existing = parsed.containers ?? [];
    const existingClasses = new Set(existing.map((entry) => entry.class_name));
    const missing = containers.filter((container) => !existingClasses.has(container.className));

    let nextText = text;
    const added: string[] = [];

    if (missing.length > 0) {
        nextText = applyModify(nextText, ["containers"], [...existing, ...missing.map((container) => containerEntryFor(container))]);
        added.push(...missing.map((container) => `containers/${container.className}`));
    }

    if (parsed.observability === undefined) {
        nextText = applyModify(nextText, ["observability"], { enabled: true });
        added.push("observability (container logs)");
    }

    return { added, text: nextText };
};

/**
 * Reconcile inferred Durable Object / D1 bindings into `wrangler.jsonc`.
 *
 * Writes only when something is missing; returns `changed: false` when the
 * config already satisfies the inferred needs.
 */
const reconcileWranglerBindings = (projectRoot: string, inferred: InferredBindings): ReconcileBindingsResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (!wranglerPath) {
        // No config to inspect — emit the raw capability hints unfiltered.
        return { added: [], changed: false, reason: "wrangler.jsonc not found", warnings: collectWarnings(inferred) };
    }

    const { parsed, text: original } = readWranglerJsonc<WranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return { added: [], changed: false, reason: `failed to parse ${wranglerPath} as JSONC`, warnings: collectWarnings(inferred), wranglerPath };
    }

    // Hints are filtered against the existing config so a wired-up project is quiet.
    const warnings = collectWarnings(inferred, parsed);

    // Only exported container classes are provisionable — wrangler rejects a
    // class_name the worker doesn't export. Their DO bindings + migration
    // classes ride through `reconcileDurableObjects` alongside the built-ins.
    const exportedContainers = inferred.containers.filter((container) => container.exported);
    const requiredDurableObjects: DurableObjectSpec[] = [
        ...inferred.durableObjects,
        ...exportedContainers.map((container) => {
            return { binding: container.bindingName, className: container.className };
        }),
    ];

    // Each step rewrites `text` but reads the original `parsed`; this is only
    // safe because the steps touch disjoint top-level keys (durable_objects /
    // migrations vs d1_databases vs ai vs containers / observability). A future
    // step that depends on a key an earlier step mutated must re-parse rather
    // than reuse `parsed`.
    const doStep = reconcileDurableObjects(original, parsed, requiredDurableObjects);
    const d1Step = inferred.needsD1 ? reconcileD1(doStep.text, parsed) : { added: [], text: doStep.text };
    const aiStep = inferred.usesAi ? reconcileAi(d1Step.text, parsed) : { added: [], text: d1Step.text };
    const containerStep = exportedContainers.length > 0 ? reconcileContainers(aiStep.text, parsed, exportedContainers) : { added: [], text: aiStep.text };

    // A freshly-written DB binding carries a placeholder id; surface it so the
    // user runs `wrangler d1 create` before the deploy reaches wrangler (which
    // would otherwise fail late on the literal placeholder).
    if (d1Step.added.length > 0) {
        warnings.push(
            `wrote a DB binding with a placeholder database_id ("${D1_PLACEHOLDER_ID}") — run \`wrangler d1 create <name>\` and replace it before deploying.`,
        );
    }

    if (containerStep.text === original) {
        return { added: [], changed: false, reason: "bindings already in sync", warnings, wranglerPath };
    }

    writeFileSync(wranglerPath, containerStep.text, "utf8");

    return { added: [...doStep.added, ...d1Step.added, ...aiStep.added, ...containerStep.added], changed: true, warnings, wranglerPath };
};

export type { ReconcileBindingsResult };
export { reconcileWranglerBindings };
