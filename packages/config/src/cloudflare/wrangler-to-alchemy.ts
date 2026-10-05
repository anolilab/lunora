/**
 * Translate a `wrangler.jsonc` into an [Alchemy 2](https://alchemy.run) program.
 *
 * # Why translate rather than ask for a second config
 *
 * `wrangler.jsonc` is already the source of truth for what an app needs, and
 * Lunora already infers and reconciles it — `inferLunoraBindings` decides that
 * a project needs a shard namespace and a bucket, `reconcileWranglerBindings`
 * writes them. Asking a developer to restate all of that in an
 * `alchemy.run.ts` would give the project two sources of truth that drift, and
 * the drift would surface as a deploy that provisions something the app does
 * not bind.
 *
 * So Alchemy is an output, not a thing to configure: read the config, emit the
 * program, run it with `alchemy deploy alchemy.run.ts --stage <stage>`.
 *
 * # Why Alchemy 2
 *
 * Lunora Cloud provisions tenant Workers with Alchemy 2
 * (`apps/cloud/containers/provision`). Emitting the same version means a
 * project can move between the managed platform and its own account — or run
 * both — with one tool and one resource model.
 *
 * # Why this emits source rather than calling Alchemy
 *
 * Alchemy 2 is an Effect program with a Node-shaped engine (rolldown, `fs`, a
 * state store). `@lunora/config` is imported by `@lunora/vite`, so importing
 * Alchemy here would push that tree into every project that merely wanted to
 * read `lunora.config.*`, and into any bundle targeting workerd — where none
 * of it survives.
 *
 * Emitting text keeps this module pure and dependency-free. Alchemy is invoked
 * as a CLI against the generated file, so it only has to exist on the machine
 * that deploys (`alchemy@2.0.0-beta.79` with `effect@4.0.0-rc.117` is the
 * pinned pair the provision box runs).
 *
 * # Adoption, not re-creation
 *
 * A project translated from an existing `wrangler.jsonc` already *has* its D1
 * database and its bucket, with data in them. Alchemy 2 decides this in its
 * planner (`Plan.ts`): with no state for a resource it calls the provider's
 * `read`, which looks the resource up by its physical name. D1, KV, R2, Queue
 * and Vectorize carry no ownership tags, so a match is adopted silently. A
 * Worker is tagged, and an untagged one (deployed by wrangler) reads as
 * `Unowned` — the planner then fails with `OwnedBySomeoneElse` unless the
 * adopt policy is on (`AdoptPolicy.ts`).
 *
 * So the emitted stack body is piped through `AdoptPolicy.adopt(true)`: the
 * in-program equivalent of `alchemy deploy --adopt`, captured on every
 * resource at registration. Every resource also gets an explicit `name` (or
 * KV `title`) taken from the config, because that name is what `read` matches
 * on — a generated name would never match and Alchemy would create alongside.
 *
 * KV is the one gap: Alchemy adopts a namespace by title, and wrangler records
 * only its id. The binding name stands in for the title, with a comment in the
 * emitted source saying to set the real one before deploying to an account
 * that already has the namespace.
 */
import type { WranglerQueueConsumer } from "./wrangler-config";

/** A Durable Object binding as `wrangler.jsonc` spells it. */
interface WranglerDurableObjectBinding {
    class_name?: string;
    name?: string;
    script_name?: string;
}

/** The slice of `wrangler.jsonc` that translates into Alchemy resources. */
interface WranglerConfigShape {
    ai?: { binding?: string };
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>;
    /** Static assets. Alchemy 2 always binds them as `ASSETS`. */
    assets?: { binding?: string; directory?: string; html_handling?: string; not_found_handling?: string; run_worker_first?: boolean | ReadonlyArray<string> };
    browser?: { binding?: string };
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    d1_databases?: ReadonlyArray<{ binding?: string; database_id?: string; database_name?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    hyperdrive?: ReadonlyArray<{ binding?: string; id?: string }>;
    images?: { binding?: string };
    kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string }>;
    main?: string;
    /** `new_sqlite_classes` marks which DO classes get SQLite storage. */
    migrations?: ReadonlyArray<{ new_classes?: ReadonlyArray<string>; new_sqlite_classes?: ReadonlyArray<string>; tag?: string }>;
    name?: string;
    queues?: { consumers?: ReadonlyArray<WranglerQueueConsumer>; producers?: ReadonlyArray<{ binding?: string; queue?: string }> };
    r2_buckets?: ReadonlyArray<{ binding?: string; bucket_name?: string }>;
    tail_consumers?: ReadonlyArray<{ service?: string }>;
    triggers?: { crons?: ReadonlyArray<string> };
    vars?: Readonly<Record<string, unknown>>;
    vectorize?: ReadonlyArray<{ binding?: string; index_name?: string }>;
    workers_dev?: boolean;
    workflows?: ReadonlyArray<{ binding?: string; class_name?: string; name?: string; script_name?: string }>;
}

/** What the translation could not carry over, so the caller can say so out loud. */
interface AlchemyTranslation {
    /** The emitted program source (`alchemy.run.ts`). */
    source: string;

    /**
     * Sections present in `wrangler.jsonc` that this translation drops.
     *
     * Reported rather than silently omitted: a deploy that quietly loses a
     * service binding produces a worker whose `env.AUTH` is undefined at
     * runtime, and nothing in the build says why.
     */
    unsupported: ReadonlyArray<string>;
}

/** JSON-encode for embedding in emitted source. */
const literal = (value: unknown): string => JSON.stringify(value);

/**
 * Whether a binding name can be emitted as a bare object key / identifier.
 *
 * A binding is an env var name, so in practice it is `SCREAMING_SNAKE` — but
 * nothing enforces that, and a name with a hyphen would emit a program that
 * does not parse. Quoting the odd ones keeps the emitter total.
 */
const SAFE_IDENTIFIER = /^[A-Z_a-z][\w$]*$/u;

const isSafeIdentifier = (name: string): boolean => SAFE_IDENTIFIER.test(name);

/** The local const an emitted resource binds to, unique per binding name. */
const localName = (binding: string): string => (isSafeIdentifier(binding) ? binding : `binding_${binding.replaceAll(/\W/gu, "_")}`);

/**
 * One entry of the worker's `env` object.
 *
 * Emits shorthand (`DB,`) when the binding name is already the local const —
 * the generated file gets read by humans debugging a deploy, and `DB: DB` is
 * noise.
 */
const envEntry = (binding: string, value: string = localName(binding)): string => {
    const safe = isSafeIdentifier(binding);

    if (safe && value === binding) {
        return `${binding},`;
    }

    return `${safe ? binding : literal(binding)}: ${value},`;
};

/**
 * The set of Durable Object classes that use SQLite storage.
 *
 * Wrangler records it once per migration entry, so it is accumulated across
 * all of them rather than read off the newest — a class introduced in `v1` is
 * still SQLite-backed at `v3`.
 */
const sqliteClasses = (config: WranglerConfigShape): ReadonlySet<string> => {
    const classes = new Set<string>();

    for (const migration of config.migrations ?? []) {
        for (const className of migration.new_sqlite_classes ?? []) {
            classes.add(className);
        }
    }

    return classes;
};

/** Sections this translation emits, or deliberately has no use for. Anything else is reported. */
const HANDLED_FIELDS = new Set([
    "$schema",
    "account_id",
    "ai",
    "analytics_engine_datasets",
    "assets",
    "browser",
    "compatibility_date",
    "compatibility_flags",
    "d1_databases",
    "durable_objects",
    "images",
    "keep_vars",
    "kv_namespaces",
    "main",
    "migrations",
    "minify",
    "name",
    // Alchemy 2 enables Workers Logs by default, which is what Lunora writes.
    "observability",
    "queues",
    "r2_buckets",
    "rules",
    "tail_consumers",
    "triggers",
    "upload_source_maps",
    "vars",
    "vectorize",
    "workers_dev",
    "workflows",
]);

/** Why a section with an Alchemy 2 resource still cannot be carried over from wrangler alone. */
const UNSUPPORTED_REASONS: Readonly<Record<string, string>> = {
    hyperdrive: "hyperdrive (Alchemy creates a Hyperdrive config from origin credentials wrangler.jsonc does not carry)",
};

/**
 * Accumulates the emitted program as it is built: resource declarations,
 * `env` entries, and whatever gets reported.
 */
interface Emission {
    env: string[];
    /** Statements after the worker (queue consumers need its script name). */
    post: string[];
    resources: string[];
    unsupported: string[];
}

/** D1, R2, KV, Queue producers and Vectorize: declared by physical name so `read` adopts an existing one. */
const emitProvisioned = (config: WranglerConfigShape, out: Emission): Map<string, string> => {
    const queueConsts = new Map<string, string>();
    const declare = (binding: string | undefined, construct: string, props: string, comment?: string): void => {
        if (binding === undefined) {
            return;
        }

        if (comment !== undefined) {
            out.resources.push(`// ${comment}`);
        }

        out.resources.push(`const ${localName(binding)} = yield* Cloudflare.${construct}(${literal(binding)}, ${props});`);
        out.env.push(envEntry(binding));
    };

    for (const d1 of config.d1_databases ?? []) {
        declare(d1.binding, "D1.Database", `{ name: ${literal(d1.database_name ?? d1.binding)} }`);
    }

    for (const r2 of config.r2_buckets ?? []) {
        declare(r2.binding, "R2.Bucket", `{ name: ${literal(r2.bucket_name ?? r2.binding)} }`);
    }

    for (const kv of config.kv_namespaces ?? []) {
        declare(
            kv.binding,
            "KV.Namespace",
            `{ title: ${literal(kv.binding)} }`,
            `Adopted by title, and wrangler records only the id: set the namespace's real title here before deploying to an account that has it.`,
        );
    }

    for (const producer of config.queues?.producers ?? []) {
        if (producer.binding !== undefined && producer.queue !== undefined) {
            queueConsts.set(producer.queue, localName(producer.binding));
        }

        declare(producer.binding, "Queues.Queue", `{ name: ${literal(producer.queue ?? producer.binding)} }`);
    }

    for (const index of config.vectorize ?? []) {
        declare(
            index.binding,
            "Vectorize.Index",
            `{ name: ${literal(index.index_name ?? index.binding)} }`,
            "Adopts the existing index; to create it fresh, add its `dimensions` and `metric` (wrangler.jsonc does not carry them).",
        );
    }

    return queueConsts;
};

/** The binding-only kinds: nothing to provision, an `env` descriptor each. */
const emitBindingOnly = (config: WranglerConfigShape, out: Emission): void => {
    for (const dataset of config.analytics_engine_datasets ?? []) {
        if (dataset.binding !== undefined) {
            out.env.push(
                envEntry(
                    dataset.binding,
                    `Cloudflare.AnalyticsEngine.Dataset(${literal(dataset.binding)}, { dataset: ${literal(dataset.dataset ?? dataset.binding)} })`,
                ),
            );
        }
    }

    for (const [section, construct] of [
        [config.ai, "Workers.AI"],
        [config.browser, "Workers.Browser"],
        [config.images, "Images.Images"],
    ] as const) {
        if (section?.binding !== undefined) {
            out.env.push(envEntry(section.binding, `Cloudflare.${construct}(${literal(section.binding)})`));
        }
    }
};

/** Durable Objects, hosted here or (with `script_name`) by another Worker. */
const emitDurableObjects = (config: WranglerConfigShape, out: Emission): void => {
    const sqlite = sqliteClasses(config);

    for (const durableObject of config.durable_objects?.bindings ?? []) {
        if (durableObject.name === undefined || durableObject.class_name === undefined) {
            continue;
        }

        const scriptName = durableObject.script_name === undefined ? "" : `, scriptName: ${literal(durableObject.script_name)}`;

        // Alchemy 2 derives the migration itself: an existing class is matched
        // by binding name, a new one is always created SQLite-backed. So only a
        // KV-backed class this Worker hosts needs saying out loud.
        if (durableObject.script_name === undefined && !sqlite.has(durableObject.class_name)) {
            out.env.push(
                `// ${durableObject.class_name} is KV-backed in wrangler.jsonc; Alchemy 2 keeps an existing class as-is but creates a new one SQLite-backed.`,
            );
        }

        out.env.push(
            envEntry(
                durableObject.name,
                `Cloudflare.Workers.DurableObject(${literal(durableObject.name)}, { className: ${literal(durableObject.class_name)}${scriptName} })`,
            ),
        );
    }
};

/** Workflows, registered under the name Alchemy derives from the host script and class. */
const emitWorkflows = (config: WranglerConfigShape, out: Emission): void => {
    for (const workflow of config.workflows ?? []) {
        if (workflow.binding === undefined) {
            continue;
        }

        const className = workflow.class_name ?? workflow.binding;
        const scriptName = workflow.script_name === undefined ? "" : `, scriptName: ${literal(workflow.script_name)}`;

        // Alchemy names a Workflow `<script>-<class>-<hash>`, not wrangler's `name`.
        if (workflow.name !== undefined) {
            out.env.push(`// Workflow "${workflow.name}": Alchemy 2 registers it under its own derived name, so instances of the old one stay there.`);
        }

        out.env.push(envEntry(workflow.binding, `Cloudflare.Workflows.Workflow(${literal(className)}, { className: ${literal(className)}${scriptName} })`));
    }
};

/**
 * Queue consumers attach the Worker to a queue after it exists. A consumed
 * queue with no producer binding is declared here, adopted by name like the
 * rest.
 */
const emitConsumers = (config: WranglerConfigShape, queueConsts: Map<string, string>, out: Emission): void => {
    for (const consumer of config.queues?.consumers ?? []) {
        if (consumer.queue === undefined) {
            continue;
        }

        // A pull consumer has no Worker to attach; it is read over HTTP.
        if (consumer.type === "http_pull") {
            out.unsupported.push(`queues.consumers "${consumer.queue}" (http_pull)`);

            continue;
        }

        let queueConst = queueConsts.get(consumer.queue);

        if (queueConst === undefined) {
            queueConst = `queue_${consumer.queue.replaceAll(/\W/gu, "_")}`;
            queueConsts.set(consumer.queue, queueConst);
            out.resources.push(`const ${queueConst} = yield* Cloudflare.Queues.Queue(${literal(consumer.queue)}, { name: ${literal(consumer.queue)} });`);
        }

        const settings = Object.entries({
            batchSize: consumer.max_batch_size,
            maxConcurrency: consumer.max_concurrency,
            maxRetries: consumer.max_retries,
            maxWaitTimeMs: consumer.max_batch_timeout === undefined ? undefined : consumer.max_batch_timeout * 1000,
            retryDelay: consumer.retry_delay,
        }).filter(([, value]) => value !== undefined);

        const props = [
            `queueId: ${queueConst}.queueId`,
            "scriptName: worker.workerName",
            consumer.dead_letter_queue === undefined ? undefined : `deadLetterQueue: ${literal(consumer.dead_letter_queue)}`,
            settings.length === 0 ? undefined : `settings: { ${settings.map(([key, value]) => `${key}: ${String(value)}`).join(", ")} }`,
        ].filter((prop): prop is string => prop !== undefined);

        out.post.push(`yield* Cloudflare.Queues.Consumer(${literal(`${consumer.queue}-consumer`)}, { ${props.join(", ")} });`);
    }
};

/** Everything present in the config that no emitter above consumed. */
const collectUnsupported = (config: WranglerConfigShape, out: Emission): void => {
    for (const [field, value] of Object.entries(config)) {
        if (HANDLED_FIELDS.has(field) || value === undefined || (Array.isArray(value) && value.length === 0)) {
            continue;
        }

        out.unsupported.push(UNSUPPORTED_REASONS[field] ?? field);
    }

    if (config.assets?.binding !== undefined && config.assets.binding !== "ASSETS") {
        out.unsupported.push(`assets.binding "${config.assets.binding}" (Alchemy 2 always binds assets as ASSETS)`);
    }
};

/** The worker's props, one line each, omitting what the config does not set. */
const workerProps = (config: WranglerConfigShape, workerName: string, env: ReadonlyArray<string>): string[] => {
    const { assets } = config;
    const assetsProps =
        assets?.directory === undefined
            ? undefined
            : Object.entries({
                  directory: assets.directory,
                  htmlHandling: assets.html_handling,
                  notFoundHandling: assets.not_found_handling,
                  runWorkerFirst: assets.run_worker_first,
              })
                  .filter(([, value]) => value !== undefined)
                  .map(([key, value]) => `${key}: ${literal(value)}`)
                  .join(", ");
    const compatibility = Object.entries({
        date: config.compatibility_date,
        flags: config.compatibility_flags?.length ? config.compatibility_flags : undefined,
    })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${literal(value)}`);
    const tailConsumers = (config.tail_consumers ?? []).flatMap((consumer) => (consumer.service === undefined ? [] : [consumer.service]));

    return [
        `name: ${literal(workerName)},`,
        config.main === undefined ? undefined : `main: ${literal(config.main)},`,
        assetsProps === undefined ? undefined : `assets: { ${assetsProps} },`,
        compatibility.length === 0 ? undefined : `compatibility: { ${compatibility.join(", ")} },`,
        config.triggers?.crons === undefined || config.triggers.crons.length === 0 ? undefined : `crons: ${literal(config.triggers.crons)},`,
        tailConsumers.length === 0 ? undefined : `tailConsumers: ${literal(tailConsumers)},`,
        config.workers_dev === undefined ? undefined : `workersDev: ${String(config.workers_dev)},`,
        env.length === 0 ? undefined : `env: {\n                ${env.join("\n                ")}\n            },`,
    ].filter((line): line is string => line !== undefined);
};

/**
 * Translate a parsed `wrangler.jsonc` into an Alchemy 2 program.
 *
 * Pure: it reads nothing and writes nothing, so the caller decides where the
 * source lands and the whole thing stays testable as a string comparison.
 * @param config The parsed `wrangler.jsonc`.
 * @returns the program source, plus whatever could not be carried over.
 */
const wranglerToAlchemy = (config: WranglerConfigShape): AlchemyTranslation => {
    const workerName = config.name ?? "worker";
    const out: Emission = { env: [], post: [], resources: [], unsupported: [] };

    const queueConsts = emitProvisioned(config, out);

    emitBindingOnly(config, out);
    emitDurableObjects(config, out);
    emitWorkflows(config, out);

    for (const [key, value] of Object.entries(config.vars ?? {})) {
        // `literal(value)`, not `literal(String(value))`: wrangler `vars` are
        // JSON, and Alchemy binds a non-string literal as a `json` binding, so a
        // numeric `"MAX": 5` stays a number on the deployed worker.
        out.env.push(envEntry(key, literal(value)));
    }

    emitConsumers(config, queueConsts, out);
    collectUnsupported(config, out);

    const indent = (lines: ReadonlyArray<string>): string[] => lines.map((line) => `        ${line}`);

    const source = [
        "// GENERATED by @lunora/config from wrangler.jsonc — edit wrangler.jsonc and regenerate instead.",
        "//",
        "// Deploy with Alchemy 2 (pinned: alchemy@2.0.0-beta.79, effect@4.0.0-rc.117):",
        "//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npx alchemy deploy alchemy.run.ts --stage production",
        "// State is kept locally in .alchemy/ (localState); swap in Cloudflare.state() to keep it in your account.",
        "// Existing resources are adopted by name, never re-created (see AdoptPolicy.adopt below).",
        "",
        `import { AdoptPolicy, localState, Stack } from "alchemy";`,
        `import * as Cloudflare from "alchemy/Cloudflare";`,
        `import { Effect } from "effect";`,
        "",
        "export default Stack(",
        `    ${literal(workerName)},`,
        "    { providers: Cloudflare.providers(), state: localState() },",
        "    Effect.gen(function* () {",
        ...indent(out.resources),
        ...(out.resources.length === 0 ? [] : [""]),
        `        const worker = yield* Cloudflare.Workers.Worker("Worker", {`,
        ...workerProps(config, workerName, out.env).map((line) => `            ${line}`),
        "        });",
        ...(out.post.length === 0 ? [] : ["", ...indent(out.post)]),
        "",
        "        return { url: worker.url };",
        "    })",
        "        // Adopt what already exists instead of failing on it: the in-program `alchemy deploy --adopt`.",
        "        .pipe(AdoptPolicy.adopt(true)),",
        ");",
        "",
    ].join("\n");

    return { source, unsupported: out.unsupported };
};

export type { AlchemyTranslation, WranglerConfigShape };
export { sqliteClasses, wranglerToAlchemy };
