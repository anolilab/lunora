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
import { join } from "node:path";

import { containerBuildTag } from "@lunora/container";

import { DEV_VARS_FILE, parseDevVariableEntries } from "../dev-variables-format";
import type { DurableObjectSpec, InferredAgent, InferredBindings, InferredContainer, InferredQueue, InferredWorkflow } from "../infer-bindings";
import { applyModify } from "../jsonc-edit";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";
import { objectBindingEntries, stringEntries } from "./wrangler-validator";

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

/**
 * One `migrations[]` record as READ BACK from a hand-edited `wrangler.jsonc` —
 * so every list may hold a `null` (a trailing comma in a JSONC array parses to
 * one). The nullability is in the type on purpose: it was absent, the replay
 * below trusted it, and a stray `null` threw a raw `TypeError` out of a step
 * that runs on every dev-server start.
 */
interface MigrationEntry {
    deleted_classes?: ReadonlyArray<string | null | undefined>;
    new_classes?: ReadonlyArray<string | null | undefined>;
    new_sqlite_classes?: ReadonlyArray<string | null | undefined>;
    renamed_classes?: ReadonlyArray<{ from?: string; to?: string } | null | undefined>;
    tag?: string;
}

interface ContainerEntry {
    class_name?: string;
}

interface WorkflowEntry {
    binding?: string;
    class_name?: string;
    name?: string;
}

interface QueueProducerEntry {
    binding?: string;
    queue?: string;
}

interface QueueConsumerEntry {
    queue?: string;
    type?: string;
}

interface QueuesShape {
    consumers?: ReadonlyArray<QueueConsumerEntry>;
    producers?: ReadonlyArray<QueueProducerEntry>;
}

interface WranglerShape {
    ai?: { binding?: string };
    // Self-describing: { binding, dataset } with no remote id — auto-writeable (see reconcileAnalytics).
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>;
    // Self-describing: a parameterless { binding } — auto-writeable like `ai` (see reconcileBrowser).
    browser?: { binding?: string };
    containers?: ReadonlyArray<ContainerEntry>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<DurableObjectBinding> };
    // Presence-only: read here just to tell whether a requested `--env <name>`
    // is declared at all, for the advisory warning below. Never written into.
    env?: Record<string, unknown>;
    // Hint-only: the `app_id` is a remote Flagship app Lunora can't mint — warned, never written.
    flagship?: ReadonlyArray<{ app_id?: string; binding?: string }>;
    // Hint-only: the `id` is a remote Hyperdrive resource Lunora can't mint — warned, never written.
    hyperdrive?: ReadonlyArray<{ binding?: string; id?: string }>;
    // Self-describing: a parameterless { binding } — auto-writeable like `ai` (see reconcileImages).
    images?: { binding?: string };
    // Hint-only: the namespace `id` is a remote KV resource Lunora can't mint — warned, never written.
    kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string }>;
    migrations?: ReadonlyArray<MigrationEntry | null | undefined>;
    name?: string;
    observability?: { enabled?: boolean; head_sampling_rate?: number; logs?: { enabled?: boolean; head_sampling_rate?: number } };
    // Hint-only: the `pipeline` name is a remote resource Lunora can't mint — warned, never written.
    pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string; stream?: string }>;
    // Cloudflare Queues — producers + consumers, both reconciled from `lunora/queues.ts`.
    queues?: QueuesShape;
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
    workflows?: ReadonlyArray<WorkflowEntry>;
}

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
    module: "agents" | "containers" | "workflows";
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

interface ReconcileStep {
    added: string[];
    text: string;
}

/**
 * Collect hint-only binding warnings. Each carries a remote id/name Lunora
 * can't mint (a KV namespace id, a Hyperdrive id, a Pipelines pipeline name);
 * like R2's user-defined bucket name they are warned, never auto-written, and
 * the warning is suppressed once the corresponding binding array is already
 * present so a wired-up project starts the dev server clean. Self-describing
 * bindings (browser/images/analytics) are auto-written instead; see reconcile.
 */
const collectHintBindingWarnings = (inferred: InferredBindings, parsed?: WranglerShape): string[] => {
    // A Flagship binding-mode provider needs a matching `flagship[]` entry; the
    // warning keys on the *binding name* (an app can wire several Flagship apps),
    // not array length, and carries the specific name + app_id remediation.
    const flagshipBindingMissing =
        inferred.flagshipBinding !== undefined && !(parsed?.flagship ?? []).some((entry) => entry.binding === inferred.flagshipBinding);

    const rules: ReadonlyArray<[boolean, string]> = [
        [
            inferred.usesKv && (parsed?.kv_namespaces?.length ?? 0) === 0,
            "@lunora/bindings/kv is used but no kv_namespaces binding exists; add a kv_namespaces entry ({ binding, id }) and pass env.<BINDING> to createKv() — the namespace id can't be auto-provisioned.",
        ],
        [
            inferred.usesHyperdrive && (parsed?.hyperdrive?.length ?? 0) === 0,
            "@lunora/hyperdrive is used but no hyperdrive binding exists; run 'wrangler hyperdrive create' and add a 'hyperdrive' binding ({ binding, id }) — the id can't be auto-provisioned.",
        ],
        [
            inferred.usesPipelines && (parsed?.pipelines?.length ?? 0) === 0,
            "ctx.pipelines is used but no pipelines binding exists; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding, pipeline }) — the pipeline resource can't be auto-provisioned.",
        ],
        [
            flagshipBindingMissing,
            `lunora/flags.ts uses Flagship in binding mode but no flagship binding "${inferred.flagshipBinding ?? ""}" exists; add a flagship entry ({ binding: "${inferred.flagshipBinding ?? ""}", app_id }) — the app_id can't be auto-provisioned.`,
        ],
    ];

    return rules.filter(([active]) => active).map(([, warning]) => warning);
};

/**
 * Capability reminders for the x402 rails. Neither implies a wrangler binding
 * Lunora can auto-write: the charge recipient is a user-named `[vars]` entry, and
 * the pay wallet key is a Secrets Store binding created out-of-band. So both are
 * always-on reminders — nothing in `wrangler.jsonc` can confirm them away (the pay
 * binding name is `signer.secretName`, unknown here) — rather than suppressible
 * hint bindings. The pay reminder also flags the mandatory spend policy: the rail
 * moves real funds.
 */
const collectX402Warnings = (inferred: InferredBindings): string[] => {
    const rules: ReadonlyArray<[boolean, string]> = [
        [
            inferred.usesX402Charge,
            "@lunora/x402/charge is used; set the recipient wallet address as a [vars] entry (the var name is your choice) and pass it to the charge config — the x402 facilitator settles USDC to that address.",
        ],
        [
            inferred.usesX402Pay,
            "@lunora/x402/pay is used (ActionCtx-only, spends real funds); add a secrets_store_secrets[] binding holding the agent wallet key (binding name == signer.secretName) and pair the pay rail with a spend policy — ctx.secrets reads a Secrets Store binding, not .dev.vars.",
        ],
    ];

    return rules.filter(([active]) => active).map(([, warning]) => warning);
};

/**
 * The declared-but-not-re-exported warning lines for a container / workflow /
 * agent set — one per declaration the worker entry never exports (wrangler
 * would reject its `class_name` at deploy). Shared by the three cases so
 * {@link collectWarnings} stays flat; the prose mirrors each {@link ExportGap}.
 */
const unexportedDeclarationWarnings = (
    kind: string,
    module: ExportGap["module"],
    declarations: ReadonlyArray<{ className: string; exported: boolean; exportName: string }>,
): string[] =>
    declarations
        .filter((declaration) => !declaration.exported)
        .map(
            (declaration) =>
                `${kind} "${declaration.exportName}" is declared but ${declaration.className} is not exported by the worker entry; add \`export * from "./lunora/_generated/${module}"\` so its binding can be provisioned.`,
        );

/**
 * Hints for capabilities used but not safely auto-provisionable — only emitted
 * when the corresponding binding is actually **missing**. `parsed` (the existing
 * `wrangler.jsonc`, when one was read) suppresses a hint whose binding is already
 * configured, so a correctly-wired project starts the dev server clean.
 *
 * Storage is silent once any `r2_buckets` binding exists (lunora can't pick the bucket name, but if one is already declared there's nothing to add). Auth is silent once sessions have a store — a `DB` D1 binding (the default, D1-backed) or an exported `SessionDO` (DO-backed); only a project with neither has nowhere to put sessions, so only that case warns. Scheduler keys on the `SchedulerDO` export, the safe binding signal. Payment has no binding at all — state rides the app's existing `ShardDO` via `ctx.db`; its only need is the provider secret pair, which lives in `.dev.vars` (not `wrangler.jsonc`), so the reminder fires whenever payment is used and nothing here can confirm it away.
 */

/**
 * Every `@lunora/payment` provider adapter and the `.dev.vars` secret pair that
 * configures it. Mirrors the `@lunora/payment` entry in
 * `package-secrets-registry.ts` and the adapters under
 * `packages/payment/src/providers/` — a provider is "configured" when **both**
 * of its keys carry a non-empty value.
 */
const PAYMENT_PROVIDER_SECRETS: ReadonlyArray<{ keys: readonly [string, string]; label: string }> = [
    { keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], label: "Stripe" },
    { keys: ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET"], label: "Polar" },
    { keys: ["CREEM_API_KEY", "CREEM_WEBHOOK_SECRET"], label: "Creem" },
    { keys: ["AUTUMN_SECRET_KEY", "AUTUMN_WEBHOOK_SECRET"], label: "Autumn" },
    { keys: ["DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY"], label: "Dodo Payments" },
];

/** Render the provider list for the reminder, e.g. `STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Stripe) or …`. */
const describePaymentProviders = (): string => PAYMENT_PROVIDER_SECRETS.map(({ keys, label }) => `${keys[0]} + ${keys[1]} (${label})`).join(" or ");

/**
 * True when `.dev.vars` already carries a complete secret pair for any supported
 * payment provider — the reminder is then noise, so it is suppressed. A missing
 * or unreadable `.dev.vars` counts as unconfigured (warn), which is the safe
 * direction for a setup hint.
 */
const hasConfiguredPaymentProvider = (projectRoot: string): boolean => {
    let content: string;

    try {
        content = readFileSync(join(projectRoot, DEV_VARS_FILE), "utf8");
    } catch {
        return false;
    }

    const values = new Map(parseDevVariableEntries(content).map((entry) => [entry.key, entry.value]));

    return PAYMENT_PROVIDER_SECRETS.some(({ keys }) => keys.every((key) => (values.get(key) ?? "") !== ""));
};

const collectWarnings = (inferred: InferredBindings, projectRoot: string, parsed?: WranglerShape): string[] => {
    const exported = new Set(inferred.durableObjects.map((object) => object.className));
    const warnings: string[] = [];

    const hasR2Bucket = (parsed?.r2_buckets?.length ?? 0) > 0;
    // A `DB` binding already present, or a `.global()` schema that will have one
    // reconciled in, means D1-backed sessions are viable.
    const hasSessionStore = (parsed?.d1_databases?.some((binding) => binding.binding === "DB") ?? false) || inferred.needsD1;

    if (inferred.usesStorage && !hasR2Bucket) {
        warnings.push(
            "@lunora/storage is used but R2 bucket bindings have user-defined names; add an r2_buckets entry and pass env.<BINDING> to createStorage().",
        );
    }

    if (inferred.usesAuth && !exported.has("SessionDO") && !hasSessionStore) {
        warnings.push(
            "@lunora/auth is used but the worker entry exports no SessionDO; sessions are D1-backed, or export SessionDO to enable DO-backed sessions.",
        );
    }

    if (inferred.usesScheduler && !exported.has("SchedulerDO")) {
        warnings.push("@lunora/scheduler is used but the worker entry exports no SchedulerDO; export it so the SCHEDULER binding can be provisioned.");
    }

    warnings.push(
        ...unexportedDeclarationWarnings("container", "containers", inferred.containers),
        ...unexportedDeclarationWarnings("workflow", "workflows", inferred.workflows),
        ...unexportedDeclarationWarnings("agent", "agents", inferred.agents),
    );

    // Container logs are invisible without Workers observability. An absent key
    // is reconciled to enabled below; an explicit `false` is a user billing
    // decision we respect — but flag, since it silently swallows container logs.
    if (inferred.containers.length > 0 && parsed?.observability?.enabled === false) {
        warnings.push("containers are declared but observability is explicitly disabled in wrangler.jsonc — container logs will not be captured.");
    }

    if (inferred.usesPayment && !hasConfiguredPaymentProvider(projectRoot)) {
        // Payment state rides the app's existing ShardDO via ctx.db, so there is
        // no wrangler binding to provision — only the provider secrets, which
        // live in .dev.vars (not wrangler.jsonc) and the scaffolder can't
        // fabricate. Unlike the binding hints there is nothing in wrangler.jsonc
        // to confirm against, so this reads .dev.vars directly.
        warnings.push(`@lunora/payment is used; set one provider's secret pair in .dev.vars — ${describePaymentProviders()}.`);
    }

    warnings.push(...collectX402Warnings(inferred), ...collectHintBindingWarnings(inferred, parsed));

    return warnings;
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

    // A Railpack `{ build }` source: `lunora deploy` builds + pushes this local
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

    // Build args (image_vars) only make sense for an image lunora builds.
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
 * `observability` toggle. Pure.
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
 * Add any missing `queues.producers[]` (matched by binding) and
 * `queues.consumers[]` (matched by queue name) from the declared `defineQueue`
 * exports. Every queue gets a producer; push queues add a worker consumer, pull
 * queues add a `type: "http_pull"` consumer. Like workflows, queues are NOT
 * Durable Objects — this writes only the `queues` block. Pure.
 */
const reconcileQueues = (text: string, parsed: WranglerShape, queues: ReadonlyArray<InferredQueue>): ReconcileStep => {
    const existing = parsed.queues ?? {};
    const existingProducers = existing.producers ?? [];
    const existingConsumers = existing.consumers ?? [];

    const haveProducer = new Set(existingProducers.map((entry) => entry.binding));
    const haveConsumer = new Set(existingConsumers.map((entry) => entry.queue));

    const missingProducers = queues.filter((queue) => !haveProducer.has(queue.bindingName));
    const missingConsumers = queues.filter((queue) => !haveConsumer.has(queue.name));

    if (missingProducers.length === 0 && missingConsumers.length === 0) {
        return { added: [], text };
    }

    const nextProducers = [
        ...existingProducers,
        ...missingProducers.map((queue) => {
            return { binding: queue.bindingName, queue: queue.name };
        }),
    ];
    const nextConsumers = [
        ...existingConsumers,
        ...missingConsumers.map((queue) => {
            const consumer: Record<string, unknown> = { queue: queue.name };

            if (queue.mode === "pull") {
                consumer.type = "http_pull";
            }

            if (queue.tuning.maxBatchSize !== undefined) {
                consumer.max_batch_size = queue.tuning.maxBatchSize;
            }

            if (queue.tuning.maxBatchTimeout !== undefined) {
                consumer.max_batch_timeout = queue.tuning.maxBatchTimeout;
            }

            if (queue.tuning.maxRetries !== undefined) {
                consumer.max_retries = queue.tuning.maxRetries;
            }

            if (queue.tuning.deadLetterQueue !== undefined) {
                consumer.dead_letter_queue = queue.tuning.deadLetterQueue;
            }

            if (queue.tuning.retryDelay !== undefined) {
                consumer.retry_delay = queue.tuning.retryDelay;
            }

            return consumer;
        }),
    ];

    const nextText = applyModify(text, ["queues"], { consumers: nextConsumers, producers: nextProducers });

    return {
        added: [
            ...missingProducers.map((queue) => `queues.producers/${queue.bindingName}`),
            ...missingConsumers.map((queue) => `queues.consumers/${queue.name}`),
        ],
        text: nextText,
    };
};

/**
 * Reconcile inferred Durable Object / D1 bindings into `wrangler.jsonc`.
 *
 * Writes only when something is missing; returns `changed: false` when the
 * config already satisfies the inferred needs.
 *
 * `environment`, when passed, does NOT change where this writes — every step
 * below still only touches the TOP-LEVEL config; wrangler's `env.<name>`
 * blocks have no auto-provisioning path today. It is used only to emit an
 * advisory warning, because bindings (`durable_objects`, `d1_databases`, …)
 * are non-inheritable (see `wrangler-validator.ts`'s `NON_INHERITABLE_KEYS`):
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
        return { added: [], changed: false, exportGaps, reason: "wrangler.jsonc not found", warnings: collectWarnings(inferred, projectRoot) };
    }

    const { parsed, text: original } = readWranglerJsonc<WranglerShape>(wranglerPath);

    if (parsed === undefined) {
        return {
            added: [],
            changed: false,
            exportGaps,
            reason: `failed to parse ${wranglerPath} as JSONC`,
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
                ? `auto-provisioned bindings are written to the top level of wrangler.jsonc only — "env.${environment}" has its own (non-inheritable) bindings and must be reconciled by hand; \`lunora deploy --env ${environment}\` now validates them, so a gap here will be reported at deploy time.`
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

    // The reconcile pipeline: each enabled step rewrites `text` but reads the
    // original `parsed`. This is only safe because the steps touch disjoint
    // top-level keys (durable_objects / migrations vs d1_databases vs ai vs
    // browser vs images vs analytics_engine_datasets vs containers /
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
        { enabled: true, run: (text) => reconcileObservability(text, parsed) },
        { enabled: exportedContainers.length > 0, run: (text) => reconcileContainers(text, parsed, exportedContainers) },
        {
            enabled: exportedWorkflows.length > 0 || exportedAgents.length > 0,
            run: (text) => reconcileWorkflows(text, parsed, exportedWorkflows, exportedAgents),
        },
        { enabled: inferred.queues.length > 0, run: (text) => reconcileQueues(text, parsed, inferred.queues) },
    ];

    let text = original;
    const added: string[] = [];

    for (const step of pipeline) {
        if (!step.enabled) {
            continue;
        }

        const result = step.run(text);

        text = result.text;
        added.push(...result.added);
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
        return { added: [], changed: false, exportGaps, reason: "bindings already in sync", warnings, wranglerPath };
    }

    writeFileSync(wranglerPath, text, "utf8");

    return { added, changed: true, exportGaps, warnings, wranglerPath };
};

export type { ExportGap, ReconcileBindingsResult };
export { collectExportGaps, reconcileWranglerBindings };
