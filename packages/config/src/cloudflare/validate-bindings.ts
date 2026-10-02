/**
 * Validating a wrangler config's bindings: Durable Objects and their migrations,
 * containers, queues, workflows, D1, and the hint / self-describing binding kinds.
 */

import type { SchemaInfo } from "../schema-info";
import { isPlainObject, settingLeaf, WORKFLOW_SETTINGS } from "./workflow-settings";
import type { WranglerConfig, WranglerContainerEntry } from "./wrangler-config";

/**
 * Schema-declared vector indexes must each have a matching `vectorize` binding.
 * Extracted from `validateWranglerConfig` to keep its cognitive complexity
 * within bounds; pushes any mismatches onto the shared `errors` array.
 */
const validateVectorizeBindings = (wrangler: WranglerConfig, vectorIndexNames: ReadonlyArray<string>, errors: string[]): void => {
    if (vectorIndexNames.length === 0) {
        return;
    }

    const vectorizeBindings = wrangler.vectorize ?? [];
    const declaredIndexNames = new Set(vectorizeBindings.filter(Boolean).map((binding) => binding?.index_name));

    for (const indexName of vectorIndexNames) {
        if (!declaredIndexNames.has(indexName)) {
            errors.push(`schema declares vector index "${indexName}"; wrangler "vectorize" must include a binding with index_name "${indexName}"`);
        }
    }
};

/** Named instance types Cloudflare accepts (plus the legacy `dev`/`standard` aliases). */
const NAMED_INSTANCE_TYPES = new Set(["basic", "dev", "lite", "standard", "standard-1", "standard-2", "standard-3", "standard-4"]);

/** Documented bounds for custom instance types. */
const CUSTOM_INSTANCE_LIMITS = { disk_mb: 20_000, memory_mib: 12_288, vcpu: 4 } as const;

/** Validate one entry's `instance_type` (named or custom object). */
const validateInstanceType = (entry: WranglerContainerEntry, label: string, errors: string[]): void => {
    const instanceType = entry.instance_type;

    if (instanceType === undefined) {
        return;
    }

    if (typeof instanceType === "string") {
        if (!NAMED_INSTANCE_TYPES.has(instanceType)) {
            errors.push(
                `${label} has unknown instance_type "${instanceType}" — expected lite, basic, standard-1..4, or a custom { vcpu, memory_mib, disk_mb } object`,
            );
        }

        return;
    }

    for (const [field, limit] of Object.entries(CUSTOM_INSTANCE_LIMITS) as ReadonlyArray<[keyof typeof CUSTOM_INSTANCE_LIMITS, number]>) {
        const value = instanceType[field];

        if (value !== undefined && (typeof value !== "number" || value <= 0 || value > limit)) {
            errors.push(`${label} custom instance_type ${field} must be a positive number ≤ ${String(limit)} (got ${String(value)})`);
        }
    }

    const { disk_mb: diskMb, memory_mib: memoryMib, vcpu } = instanceType;

    if (typeof vcpu === "number" && typeof memoryMib === "number" && memoryMib < vcpu * 3072) {
        errors.push(`${label} custom instance_type needs ≥ 3 GiB (3072 MiB) memory per vCPU (got ${String(memoryMib)} MiB for ${String(vcpu)} vCPU)`);
    }

    if (typeof memoryMib === "number" && typeof diskMb === "number") {
        const maxDiskMb = Math.floor((memoryMib / 1024) * 2000);

        if (diskMb > maxDiskMb) {
            errors.push(
                `${label} custom instance_type allows ≤ 2 GB disk per GiB memory (≤ ${String(maxDiskMb)} MB for ${String(memoryMib)} MiB memory; got ${String(diskMb)} MB)`,
            );
        }
    }
};

/**
 * Validate a `durable_object`-scheduled entry: it takes named `images` (each
 * with exactly one of `dockerfile` / `image`) instead of an application-wide
 * `image`, and rejects the default-policy fields Cloudflare does not accept.
 */
const validateDurableObjectScheduledEntry = (entry: WranglerContainerEntry, label: string, errors: string[]): void => {
    for (const field of ["image", "instance_type", "max_instances"] as const) {
        if (entry[field] !== undefined) {
            errors.push(
                `${label} sets "${field}", which the durable_object scheduling policy does not take — the Durable Object picks image and size at start`,
            );
        }
    }

    for (const [name, image] of Object.entries(entry.images ?? {})) {
        const sources = [image?.dockerfile, image?.image].filter((source) => typeof source === "string" && source.length > 0);

        if (sources.length !== 1) {
            errors.push(`${label} images["${name}"] must set exactly one of "dockerfile" or "image"`);
        }
    }
};

/** Shared lookups + sinks for one `containers[]` entry validation pass. */
interface ContainerEntryChecks {
    boundClasses: ReadonlySet<string | undefined>;
    /** Storage kind per class, folded from the migration history. */
    classKinds: ReadonlyMap<string, MigrationClassKind>;
    errors: string[];
    warnings: string[];
}

/**
 * Validate one `containers[]` entry: a `class_name` + `image`, a matching
 * `durable_objects` binding, and the class registered in a
 * `new_sqlite_classes` migration (containers require SQLite-backed DOs — a
 * `new_classes` registration deploys, then fails at runtime). Extracted from
 * {@link validateContainers} to keep its cognitive complexity bounded.
 */
const validateContainerEntry = (entry: WranglerContainerEntry | null | undefined, label: string, checks: ContainerEntryChecks): void => {
    const { boundClasses, classKinds, errors, warnings } = checks;

    if (!entry || typeof entry !== "object" || typeof entry.class_name !== "string" || entry.class_name.length === 0) {
        errors.push(`${label} must have a non-empty "class_name" naming its container-enabled Durable Object class`);

        return;
    }

    const durableObjectScheduled = entry.scheduling_policy === "durable_object";

    if (entry.scheduling_policy !== undefined && entry.scheduling_policy !== "default" && !durableObjectScheduled) {
        errors.push(`${label} ("${entry.class_name}") has unknown scheduling_policy "${entry.scheduling_policy}" — expected "default" or "durable_object"`);
    }

    if (durableObjectScheduled) {
        validateDurableObjectScheduledEntry(entry, `${label} ("${entry.class_name}")`, errors);
    } else if (typeof entry.image !== "string" || entry.image.length === 0) {
        errors.push(`${label} ("${entry.class_name}") must have an "image" — a Dockerfile path or a registry reference`);
    }

    if (!boundClasses.has(entry.class_name)) {
        errors.push(
            `${label} class "${entry.class_name}" has no matching durable_objects binding — your dev server auto-reconciles this on startup; add { "name": "...", "class_name": "${entry.class_name}" } to fix it by hand`,
        );
    }

    const classKind = classKinds.get(entry.class_name);

    if (classKind !== "sqlite") {
        errors.push(
            classKind === "classic"
                ? `${label} class "${entry.class_name}" is registered via "new_classes" but containers require SQLite-backed DOs — move it to "new_sqlite_classes"`
                : `${label} class "${entry.class_name}" is missing from migrations — add a migration entry with "new_sqlite_classes": ["${entry.class_name}"]`,
        );
    }

    validateInstanceType(entry, `${label} ("${entry.class_name}")`, errors);

    // The `durable_object` policy has no max_instances to set: its instances count
    // against the account limit instead.
    if (entry.max_instances === undefined && !durableObjectScheduled) {
        warnings.push(`${label} ("${entry.class_name}") declares no max_instances — set a cap so a traffic spike can't fan out unbounded container spend`);
    }
};

/** A non-empty string — the shape every binding's required fields must satisfy. */
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The object-typed entries of a possibly-malformed bindings array from untrusted
 * JSONC. Tolerates a non-array value (e.g. a stray string) and drops `null` /
 * non-object entries (a trailing comma in JSONC parses to `[null]`), so callers
 * can safely `.find`/`.map` string fields without a raw `TypeError`.
 */
const objectBindingEntries = <T>(value: ReadonlyArray<T | null | undefined> | undefined): T[] =>
    Array.isArray(value) ? value.filter((entry): entry is T => entry !== null && typeof entry === "object") : [];

/**
 * The string members of a hand-written array field, or `[]` for anything that
 * isn't one — the string-valued twin of {@link objectBindingEntries}, and needed
 * for the same reason: a `wrangler.jsonc` is hand-edited, so `"new_classes": {}`
 * would make a bare `for…of` throw a raw `TypeError` out of the validator, and
 * `"new_classes": "ShardDO"` would fold in one CHARACTER per iteration.
 */
const stringEntries = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).filter((entry) => isNonEmptyString(entry)) : []);

/**
 * How a Durable Object class is stored — `sqlite` (`new_sqlite_classes`) or the
 * legacy key-value `classic` (`new_classes`). Containers require `sqlite`.
 */
type MigrationClassKind = "classic" | "sqlite";

/**
 * Fold `wrangler.migrations[]` IN ORDER into the Durable Object classes that
 * currently exist and how each is stored, applying each entry's `new_classes` +
 * `new_sqlite_classes` (add), then its `renamed_classes` (from → to), then its
 * `deleted_classes` (remove) — in that order, one entry at a time.
 *
 * This must stay a fold, not a single-entry membership scan: a class added in
 * one entry and renamed in a later one is only findable under its NEW name,
 * and a class added then later deleted must NOT be findable at all. A naive
 * "does this class appear anywhere in migrations" check gets both cases
 * wrong. See plan 353.
 */
const foldMigrationClassKinds = (migrations: WranglerConfig["migrations"]): ReadonlyMap<string, MigrationClassKind> => {
    const classes = new Map<string, MigrationClassKind>();

    for (const migration of objectBindingEntries(migrations)) {
        for (const name of stringEntries(migration.new_classes)) {
            classes.set(name, "classic");
        }

        for (const name of stringEntries(migration.new_sqlite_classes)) {
            classes.set(name, "sqlite");
        }

        for (const rename of objectBindingEntries(migration.renamed_classes)) {
            if (isNonEmptyString(rename.from) && isNonEmptyString(rename.to)) {
                // A rename carries the storage kind across. Renaming a class no
                // entry ever registered is not something wrangler accepts, so the
                // kind is unknowable — assume `sqlite` rather than invent a
                // "move it to new_sqlite_classes" error for it.
                const kind = classes.get(rename.from) ?? "sqlite";

                classes.delete(rename.from);
                classes.set(rename.to, kind);
            }
        }

        for (const name of stringEntries(migration.deleted_classes)) {
            classes.delete(name);
        }
    }

    return classes;
};

/** The class names {@link foldMigrationClassKinds} says currently exist, without their storage kind. */
const foldMigrationClasses = (migrations: WranglerConfig["migrations"]): ReadonlySet<string> => new Set(foldMigrationClassKinds(migrations).keys());

/**
 * Every `durable_objects.bindings[]` entry whose class lives in THIS script
 * (no `script_name`) must be a class {@link foldMigrationClasses} says
 * currently exists — otherwise `wrangler deploy` fails with "You must add a
 * new migration for the following durable object classes: X", a hard deploy
 * failure this validator exists to catch before deploy time. A binding
 * naming a class in ANOTHER script is that script's migrations to carry, not
 * this config's (same carve-out as `collectUnexportedClassErrors`).
 */
const validateDurableObjectMigrations = (wrangler: WranglerConfig, errors: string[]): void => {
    const currentClasses = foldMigrationClasses(wrangler.migrations);

    for (const binding of objectBindingEntries(wrangler.durable_objects?.bindings)) {
        if (binding.script_name === undefined && isNonEmptyString(binding.class_name) && !currentClasses.has(binding.class_name)) {
            errors.push(
                `durable_objects.bindings declares class "${binding.class_name}" but it is missing from migrations — ` +
                    `add a migration entry with "new_sqlite_classes": ["${binding.class_name}"] (or "new_classes" for a non-SQLite-backed class), ` +
                    "or let the dev server auto-reconcile it on the next start",
            );
        }
    }
};

/**
 * Every `containers[]` entry must be a container-enabled Durable Object the
 * worker actually wires up (see {@link validateContainerEntry}). Also nudges
 * when observability is off — container logs are invisible without it.
 */
const validateContainers = (wrangler: WranglerConfig, errors: string[], warnings: string[]): void => {
    if (wrangler.containers === undefined) {
        return;
    }

    if (!Array.isArray(wrangler.containers)) {
        errors.push("containers must be an array of { class_name, image, ... } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it so
    // member access below stays type-safe (mirrors `validateTailConsumers`).
    const entries = wrangler.containers as ReadonlyArray<WranglerContainerEntry | null | undefined>;

    if (entries.length === 0) {
        return;
    }

    const boundClasses = new Set(objectBindingEntries(wrangler.durable_objects?.bindings).map((binding) => binding.class_name));
    // The SAME fold the Durable Object check uses — a flat scan of
    // `new_sqlite_classes` would report a renamed container class as missing and
    // would still count one a later entry deleted, and it throws a raw
    // `TypeError` on a hand-written `"new_sqlite_classes": {}`.
    const classKinds = foldMigrationClassKinds(wrangler.migrations);

    for (const [index, entry] of entries.entries()) {
        validateContainerEntry(entry, `containers[${String(index)}]`, { boundClasses, classKinds, errors, warnings });
    }

    if (wrangler.observability?.enabled !== true) {
        warnings.push(
            'containers are configured but observability is not enabled — container logs will not be captured (add { "observability": { "enabled": true } })',
        );
    }
};

/**
 * `Array.isArray` widens the readonly element type to `any`; restore it as a
 * record of untrusted parsed entries (each may be `null`/malformed) so the
 * generic checkers below can index arbitrary string fields type-safely.
 */
const asBindingEntries = (value: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown> | null | undefined> =>
    value as ReadonlyArray<Record<string, unknown> | null | undefined>;

/** The shape checks for one binding array whose entries carry required string fields. */
interface RequiredFieldsRule {
    arrayMessage: string;
    fields: ReadonlyArray<{ field: string; message: (label: string) => string }>;
    objectMessage: (label: string) => string;
}

/**
 * Validate one required-fields binding array: a non-array value errors with the
 * rule's array message, a non-object entry with its object message; otherwise
 * every declared field must be a non-empty string. The one core behind the
 * workflows / queues / secrets-store validators and
 * {@link REQUIRED_FIELD_BINDING_RULES}.
 */
const validateRequiredFieldEntries = (value: unknown, labelPrefix: string, rule: RequiredFieldsRule, errors: string[]): void => {
    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        errors.push(rule.arrayMessage);

        return;
    }

    for (const [index, entry] of asBindingEntries(value).entries()) {
        const label = `${labelPrefix}[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(rule.objectMessage(label));

            continue;
        }

        for (const field of rule.fields) {
            if (!isNonEmptyString(entry[field.field])) {
                errors.push(field.message(label));
            }
        }
    }
};

/**
 * Each `workflows[]` entry must be a well-formed `{ name, binding, class_name }`
 * triple. Workflows are not Durable Objects, so there is nothing to cross-check
 * against `durable_objects`/`migrations` — only the shape matters here; the
 * deployed worker is responsible for exporting each `class_name`.
 */
const WORKFLOWS_RULE: RequiredFieldsRule = {
    arrayMessage: "workflows must be an array of { name, binding, class_name } entries",
    fields: [
        { field: "binding", message: (label) => `${label} must have a non-empty "binding" naming the Workflow binding (e.g. MY_WORKFLOW)` },
        { field: "class_name", message: (label) => `${label} must have a non-empty "class_name" naming the exported WorkflowEntrypoint class` },
        { field: "name", message: (label) => `${label} must have a non-empty "name" naming the deployed workflow` },
    ],
    objectMessage: (label) => `${label} must be a { name, binding, class_name } object`,
};

/**
 * `schedules` is a non-empty list of cron strings (the rule `defineWorkflow`
 * and codegen apply too); an export may also give a single string.
 */
const schedulesProblem = (schedules: unknown, allowSingle: boolean): string | undefined => {
    const valid =
        schedules === undefined ||
        (allowSingle && isNonEmptyString(schedules)) ||
        (Array.isArray(schedules) && schedules.length > 0 && (schedules as unknown[]).every((schedule) => isNonEmptyString(schedule)));

    return valid ? undefined : "schedules must be a non-empty array of cron expression strings";
};

const limitsProblem = (limits: unknown): string | undefined => {
    if (limits === undefined) {
        return undefined;
    }

    if (!isPlainObject(limits)) {
        return "limits must be an object";
    }

    return limits.steps === undefined || (Number.isInteger(limits.steps) && (limits.steps as number) > 0)
        ? undefined
        : "limits.steps must be a positive integer";
};

const retentionProblems = (retention: unknown): string[] => {
    if (retention === undefined) {
        return [];
    }

    if (!isPlainObject(retention)) {
        return ["default_retention must be an object"];
    }

    return ["success_retention", "error_retention"]
        .filter((key) => retention[key] !== undefined && !isNonEmptyString(retention[key]))
        .map((key) => `default_retention.${key} must be a duration string (e.g. "7 days")`);
};

/**
 * Shape-check a workflow's deploy settings — the same three on a `workflows[]`
 * binding and on an `exports` entry of `type: "workflow"`: `schedules` cron
 * strings, a positive-integer `limits.steps`, string `default_retention`
 * durations. Ranges (the 25,000-step ceiling, the plan's retention maximum)
 * are left to wrangler.
 */
const validateWorkflowSettingShapes = (entry: Record<string, unknown>, label: string, allowSingleSchedule: boolean, errors: string[]): void => {
    const problems = [schedulesProblem(entry.schedules, allowSingleSchedule), limitsProblem(entry.limits), ...retentionProblems(entry.default_retention)];

    for (const problem of problems) {
        if (problem !== undefined) {
            errors.push(`${label}.${problem}`);
        }
    }
};

/** The setting leaves a binding and an export of one workflow both set, to different values. */
const conflictingSettings = (binding: Record<string, unknown>, entry: Record<string, unknown>): string[] =>
    WORKFLOW_SETTINGS.map(({ path }) => path)
        .filter((path) => {
            const fromBinding = settingLeaf(binding, path);
            const fromExport = settingLeaf(entry, path);
            // An export may spell a single schedule as a bare string.
            const normalizedExport = typeof fromExport === "string" && path[0] === "schedules" ? [fromExport] : fromExport;

            return fromBinding !== undefined && fromExport !== undefined && JSON.stringify(fromBinding) !== JSON.stringify(normalizedExport);
        })
        .map((path) => path.join("."));

/**
 * Cross-check one workflow export against the `workflows[]` bindings with the
 * same `name` — which Cloudflare treats as the same Workflow: a same-Worker
 * binding must name the export's class and may not set a setting to a
 * different value; a binding to ANOTHER Worker's workflow (`script_name`) may
 * not reuse the name at all (workflow names are unique per account).
 */
const validateExportAgainstBindings = (
    className: string,
    entry: Record<string, unknown>,
    bindings: ReadonlyArray<Record<string, unknown> | null | undefined>,
    errors: string[],
): void => {
    const label = `exports["${className}"]`;
    const name = String(entry.name);

    for (const binding of bindings) {
        if (!isPlainObject(binding) || binding.name !== entry.name) {
            continue;
        }

        const bindingLabel = `workflows entry "${String(binding.binding)}"`;

        if (binding.script_name !== undefined) {
            errors.push(
                `${bindingLabel} binds workflow "${name}" in another Worker, but ${label} declares a workflow with that name here — workflow names are unique per account`,
            );

            continue;
        }

        if (binding.class_name !== className) {
            errors.push(
                `${bindingLabel} and ${label} both declare workflow "${name}" but name different classes ("${String(binding.class_name)}" vs "${className}")`,
            );
        }

        for (const path of conflictingSettings(binding, entry)) {
            errors.push(`${bindingLabel} and ${label} set ${path} to different values for workflow "${name}" — set it in one place`);
        }
    }
};

/**
 * Validate the workflow deploy settings on both declaration sites, and the
 * rules Cloudflare applies between them (Wrangler >= 4.139): an `exports`
 * entry of `type: "workflow"` is keyed by its `WorkflowEntrypoint` class and
 * needs a `name`, and must agree with any `workflows[]` binding of the same
 * name ({@link validateExportAgainstBindings}).
 *
 * Lunora writes its own workflows as exports; a `workflows[]` binding of the
 * same name only appears when written by hand (a test-only binding for
 * `introspectWorkflow`, say) — which is exactly when a conflicting setting
 * slips in.
 */
const validateWorkflowSettings = (wrangler: WranglerConfig, errors: string[]): void => {
    const bindings = Array.isArray(wrangler.workflows) ? asBindingEntries(wrangler.workflows) : [];

    for (const [index, entry] of bindings.entries()) {
        if (isPlainObject(entry)) {
            validateWorkflowSettingShapes(entry, `workflows[${String(index)}]`, false, errors);
        }
    }

    const exported = isPlainObject(wrangler.exports) ? Object.entries(wrangler.exports) : [];

    for (const [className, entry] of exported) {
        if (!isPlainObject(entry) || entry.type !== "workflow") {
            continue;
        }

        if (isNonEmptyString(entry.name)) {
            validateWorkflowSettingShapes(entry, `exports["${className}"]`, true, errors);
            validateExportAgainstBindings(className, entry, bindings, errors);
        } else {
            errors.push(`exports["${className}"] is a workflow export and must have a non-empty "name" naming the deployed workflow`);
        }
    }
};

const QUEUE_PRODUCERS_RULE: RequiredFieldsRule = {
    arrayMessage: "queues.producers must be an array of { binding, queue } entries",
    fields: [
        { field: "binding", message: (label) => `${label} must have a non-empty "binding" naming the Queue producer (e.g. QUEUE_EMAIL)` },
        { field: "queue", message: (label) => `${label} must have a non-empty "queue" naming the deployed queue` },
    ],
    objectMessage: (label) => `${label} must be a { binding, queue } object`,
};

const QUEUE_CONSUMERS_RULE: RequiredFieldsRule = {
    arrayMessage: "queues.consumers must be an array of { queue } entries",
    fields: [{ field: "queue", message: (label) => `${label} must have a non-empty "queue" naming the consumed queue` }],
    objectMessage: (label) => `${label} must be a { queue } object`,
};

/**
 * Validate the `queues` block: each producer needs a `{ binding, queue }` pair
 * (Lunora reconciles both from `lunora/queues.ts`), and each consumer needs a
 * `queue` (push or `type: "http_pull"`). Like workflows, queues are not Durable
 * Objects — only the shape matters; the queue resources are reconciled/created
 * separately.
 */
const validateQueues = (wrangler: WranglerConfig, errors: string[]): void => {
    if (wrangler.queues === undefined) {
        return;
    }

    if (typeof wrangler.queues !== "object" || Array.isArray(wrangler.queues)) {
        errors.push("queues must be a { producers, consumers } object");

        return;
    }

    validateRequiredFieldEntries(wrangler.queues.producers, "queues.producers", QUEUE_PRODUCERS_RULE, errors);
    validateRequiredFieldEntries(wrangler.queues.consumers, "queues.consumers", QUEUE_CONSUMERS_RULE, errors);
};

/**
 * Each `secrets_store_secrets[]` entry references a remote store + secret by
 * name (both created out-of-band), so only the `{ binding, store_id,
 * secret_name }` shape is checked — Lunora can't mint the store/secret.
 */
const SECRETS_STORE_RULE: RequiredFieldsRule = {
    arrayMessage: "secrets_store_secrets must be an array of { binding, store_id, secret_name } entries",
    fields: ["binding", "store_id", "secret_name"].map((field) => {
        return { field, message: (label: string) => `${label} must have a non-empty "${field}"` };
    }),
    objectMessage: (label) => `${label} must be a { binding, store_id, secret_name } object`,
};

/**
 * Hint-style binding arrays: each entry needs a non-empty `binding` (error); its
 * secondary field is a remote resource Lunora can't mint (a KV namespace id, a
 * Hyperdrive id, a Pipelines pipeline name, an AE dataset), so a missing one is
 * a warning — the binding can't resolve/connect without it, but only the user
 * can supply it. One descriptor table replaces four near-identical validators.
 */
const HINT_BINDING_RULES = [
    {
        arrayMessage: "kv_namespaces must be an array of { binding, id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the KV namespace binding`,
        hintField: "id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "id" — run \`wrangler kv namespace create\` and set the namespace id, or the binding can't resolve`,
        key: "kv_namespaces",
    },
    {
        arrayMessage: "flagship must be an array of { binding, app_id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Flagship binding`,
        hintField: "app_id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "app_id" — create a Flagship app and set its id, or the binding can't resolve`,
        key: "flagship",
    },
    {
        arrayMessage: "hyperdrive must be an array of { binding, id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Hyperdrive binding`,
        hintField: "id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "id" — run \`wrangler hyperdrive create\` and set the id, or the binding can't connect`,
        key: "hyperdrive",
    },
    {
        arrayMessage: "pipelines must be an array of { binding, stream } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Pipelines binding`,
        // wrangler renamed `pipeline` → `stream` and now deprecation-warns on the
        // old spelling; accept both so neither wrangler nor this validator is the
        // one complaining about a correctly-wired binding.
        hintField: ["stream", "pipeline"],
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "stream" — run \`wrangler pipelines create <name>\` and set the stream name, or the binding can't resolve`,
        key: "pipelines",
    },
    {
        arrayMessage: "analytics_engine_datasets must be an array of { binding, dataset } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Analytics Engine binding`,
        hintField: "dataset",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "dataset" — it defaults to the binding name; set it explicitly to avoid drift`,
        key: "analytics_engine_datasets",
    },
] as const satisfies ReadonlyArray<{
    arrayMessage: string;
    bindingMessage: (label: string) => string;
    /** Field carrying the un-mintable remote id, or every accepted spelling of it. */
    hintField: ReadonlyArray<string> | string;
    hintMessage: (label: string, binding: string) => string;
    key: keyof WranglerConfig;
}>;

/**
 * Validate one hint-style binding array (see {@link HINT_BINDING_RULES}): a
 * non-object entry or one missing a non-empty `binding` errors; an entry whose
 * hint field is absent warns.
 */
const validateHintBinding = (wrangler: WranglerConfig, rule: (typeof HINT_BINDING_RULES)[number], errors: string[], warnings: string[]): void => {
    const value = wrangler[rule.key];

    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        errors.push(rule.arrayMessage);

        return;
    }

    for (const [index, entry] of asBindingEntries(value).entries()) {
        const label = `${rule.key}[${String(index)}]`;

        if (!entry || typeof entry !== "object" || !isNonEmptyString(entry.binding)) {
            errors.push(rule.bindingMessage(label));

            continue;
        }

        // `hintField` may name several accepted spellings — a field wrangler has
        // renamed still satisfies the rule under its old name (see `pipelines`).
        // Narrowed with `typeof`, not `Array.isArray`: the latter widens a
        // `ReadonlyArray<string> | string` union to `any[]`.
        const hintFields = typeof rule.hintField === "string" ? [rule.hintField] : rule.hintField;

        if (!hintFields.some((field) => isNonEmptyString(entry[field]))) {
            warnings.push(rule.hintMessage(label, entry.binding));
        }
    }
};

/**
 * The self-describing single-object bindings — the binding name is the whole
 * config (no array, no remote id to mint). A present block must be an object
 * with a non-empty `binding`. One table replaces the Browser/Images validators.
 */
const SELF_DESCRIBING_BINDING_RULES = [
    { key: "browser", message: 'browser must be an object with a non-empty "binding" (e.g. { "binding": "BROWSER" })' },
    { key: "images", message: 'images must be an object with a non-empty "binding" (e.g. { "binding": "IMAGES" })' },
    { key: "media", message: 'media must be an object with a non-empty "binding" (e.g. { "binding": "MEDIA" })' },
    { key: "stream", message: 'stream must be an object with a non-empty "binding" (e.g. { "binding": "STREAM" })' },
] as const satisfies ReadonlyArray<{ key: keyof WranglerConfig; message: string }>;

/**
 * Validate one self-describing `{ binding }` object against its rule (pure shape
 * check). Read as `unknown`: `WranglerConfig` describes a WELL-FORMED config, but
 * the value here comes from hand-edited JSONC, where `"browser": null` is what a
 * user writes to disable a binding — and `typeof null === "object"` made the
 * property read throw a TypeError out of the whole validator.
 */
const validateSelfDescribingBinding = (wrangler: WranglerConfig, rule: (typeof SELF_DESCRIBING_BINDING_RULES)[number], errors: string[]): void => {
    const value: unknown = wrangler[rule.key];

    if (value === undefined) {
        return;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value) || !isNonEmptyString((value as { binding?: unknown }).binding)) {
        errors.push(rule.message);
    }
};

/**
 * Binding arrays whose entries carry two or more **required** string fields (a
 * missing field is an error, not a hint). Unlike the hint bindings these
 * reference targets Lunora can't discover (a service worker, a dispatch
 * namespace, an mTLS cert id), so the shape is all we police. One table replaces
 * the Services/DispatchNamespaces/MtlsCertificates validators.
 */
const REQUIRED_FIELD_BINDING_RULES = [
    {
        arrayMessage: "services must be an array of { binding, service, entrypoint? } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the service binding` },
            { field: "service", message: (label: string) => `${label} must have a non-empty "service" naming the target Worker` },
        ],
        key: "services",
        objectMessage: (label: string) => `${label} must be a { binding, service, entrypoint? } object`,
    },
    {
        arrayMessage: "dispatch_namespaces must be an array of { binding, namespace } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding"` },
            { field: "namespace", message: (label: string) => `${label} must have a non-empty "namespace" naming the dispatch namespace` },
        ],
        key: "dispatch_namespaces",
        objectMessage: (label: string) => `${label} must be a { binding, namespace } object`,
    },
    {
        arrayMessage: "mtls_certificates must be an array of { binding, certificate_id } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding"` },
            {
                field: "certificate_id",
                message: (label: string) => `${label} must have a non-empty "certificate_id" (upload via \`wrangler mtls-certificate upload\`)`,
            },
        ],
        key: "mtls_certificates",
        objectMessage: (label: string) => `${label} must be a { binding, certificate_id } object`,
    },
    {
        // Unlike kv_namespaces/hyperdrive/pipelines (HINT_BINDING_RULES), the
        // bucket_name is not a remote id Lunora waits on Cloudflare to mint —
        // it is chosen by the project, so a missing one is a structural error,
        // not a hint.
        arrayMessage: "r2_buckets must be an array of { binding, bucket_name } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the R2 bucket binding` },
            { field: "bucket_name", message: (label: string) => `${label} must have a non-empty "bucket_name" naming the deployed bucket` },
        ],
        key: "r2_buckets",
        objectMessage: (label: string) => `${label} must be a { binding, bucket_name } object`,
    },
    {
        arrayMessage: "vpc_services must be an array of { binding, service_id } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the VPC Service binding` },
            {
                field: "service_id",
                message: (label: string) => `${label} must have a non-empty "service_id" (create one with \`wrangler vpc service create\`)`,
            },
        ],
        key: "vpc_services",
        objectMessage: (label: string) => `${label} must be a { binding, service_id } object`,
    },
    {
        arrayMessage: "artifacts must be an array of { binding, namespace } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the Artifacts binding` },
            { field: "namespace", message: (label: string) => `${label} must have a non-empty "namespace" naming the Artifacts namespace` },
        ],
        key: "artifacts",
        objectMessage: (label: string) => `${label} must be a { binding, namespace } object`,
    },
] as const satisfies ReadonlyArray<RequiredFieldsRule & { key: keyof WranglerConfig }>;

/**
 * The binding each `.global()` backend needs in order to exist at all — the
 * config half of the chain requirement the unchained-capability check below
 * reads out of the source.
 *
 * The two halves are asymmetric because the builders are. `.global({ d1 })` is
 * reconciled by the dev server onto a fixed `DB`, so the exact name is checkable.
 * `.hyperdriveGlobal({ exec })` builds the driver from whatever the user's own
 * selector reads — `env.HYPERDRIVE` in the docs, but the name is theirs — so the
 * only static fact is that SOME Hyperdrive binding has to exist. Naming one would
 * false-error a project that called it something else; demanding none left these
 * tables with no config check at all, and `env.<BINDING>` is then `undefined` at
 * the first global read, throwing inside the user's `exec` where nothing here can
 * say what went wrong.
 *
 * A schema may declare both flavours, so these are independent, not exclusive.
 */
const validateGlobalBackendBindings = (wrangler: WranglerConfig, schema: SchemaInfo | undefined, errors: string[]): void => {
    if (schema?.hasD1GlobalTable && !objectBindingEntries(wrangler.d1_databases).some((binding) => binding.binding === "DB")) {
        errors.push(
            'schema declares .global() tables; d1_databases must include a binding named "DB" — your dev server auto-reconciles this on startup, or add the binding manually',
        );
    }

    if (schema?.hasHyperdriveGlobalTable && objectBindingEntries(wrangler.hyperdrive).length === 0) {
        errors.push(
            'schema declares .global({ backend: "hyperdrive" }) tables; wrangler must declare a hyperdrive binding for `.hyperdriveGlobal({ exec })` to read — ' +
                "run `wrangler hyperdrive create <name> --connection-string=...` and add " +
                '`"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }]` (any binding name works; your `exec` selector picks it)',
        );
    }
};

/**
 * Structural check for every `d1_databases[]` entry: a non-empty `binding`,
 * plus a `database_id` or a `database_name` identifying which database it
 * binds. Both are remote-ish (created via `wrangler d1 create`, which prints
 * an id and takes a name), but unlike the HINT_BINDING_RULES bindings a D1
 * entry with NEITHER is unusable, so this stays an error like the other
 * structural checks — matching {@link REQUIRED_FIELD_BINDING_RULES}'s bar
 * rather than the hint-only one. "Either field" doesn't fit
 * {@link RequiredFieldsRule} (which requires every listed field), so this is
 * hand-rolled rather than a table entry.
 */
const validateD1Databases = (wrangler: WranglerConfig, errors: string[]): void => {
    const { d1_databases: d1Databases } = wrangler;

    if (d1Databases === undefined) {
        return;
    }

    if (!Array.isArray(d1Databases)) {
        errors.push("d1_databases must be an array of { binding, database_id | database_name } entries");

        return;
    }

    for (const [index, entry] of asBindingEntries(d1Databases).entries()) {
        const label = `d1_databases[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { binding, database_id | database_name } object`);

            continue;
        }

        if (!isNonEmptyString(entry.binding)) {
            errors.push(`${label} must have a non-empty "binding" naming the D1 binding`);
        }

        if (!isNonEmptyString(entry.database_id) && !isNonEmptyString(entry.database_name)) {
            errors.push(`${label} must have a "database_id" or a "database_name" — run \`wrangler d1 create\` and set one, or the binding can't resolve`);
        }
    }
};

/**
 * Every `vpc_networks[]` entry: a non-empty `binding` plus exactly one target —
 * a Cloudflare Tunnel (`tunnel_id`) or the Cloudflare Mesh network
 * (`network_id`, `"cf1:network"`). The two are mutually exclusive, which
 * {@link RequiredFieldsRule} cannot express, so this is hand-rolled like
 * {@link validateD1Databases}.
 */
const validateVpcNetworks = (wrangler: WranglerConfig, errors: string[]): void => {
    const { vpc_networks: networks } = wrangler;

    if (networks === undefined) {
        return;
    }

    if (!Array.isArray(networks)) {
        errors.push("vpc_networks must be an array of { binding, tunnel_id | network_id } entries");

        return;
    }

    for (const [index, entry] of asBindingEntries(networks).entries()) {
        const label = `vpc_networks[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { binding, tunnel_id | network_id } object`);

            continue;
        }

        if (!isNonEmptyString(entry.binding)) {
            errors.push(`${label} must have a non-empty "binding" naming the VPC Network binding`);
        }

        if (isNonEmptyString(entry.tunnel_id) === isNonEmptyString(entry.network_id)) {
            errors.push(`${label} must set exactly one of "tunnel_id" (a Cloudflare Tunnel) or "network_id" ("cf1:network" for Cloudflare Mesh)`);
        }
    }
};

// `objectBindingEntries` / `stringEntries` are exported for `reconcile-bindings`,
// which replays the same hand-edited `migrations` list this validator folds and
// hit the same raw `TypeError` on a `null` entry. Package-internal only — the
// `./cloudflare` barrel re-exports by name and deliberately does not list them.
export {
    HINT_BINDING_RULES,
    isNonEmptyString,
    objectBindingEntries,
    REQUIRED_FIELD_BINDING_RULES,
    SECRETS_STORE_RULE,
    SELF_DESCRIBING_BINDING_RULES,
    stringEntries,
    validateContainers,
    validateD1Databases,
    validateDurableObjectMigrations,
    validateGlobalBackendBindings,
    validateHintBinding,
    validateQueues,
    validateRequiredFieldEntries,
    validateSelfDescribingBinding,
    validateVectorizeBindings,
    validateVpcNetworks,
    validateWorkflowSettings,
    WORKFLOWS_RULE,
};
