/**
 * The reconciler's warnings: bindings it cannot write (an un-mintable remote id),
 * declarations the worker entry does not export, and entries left behind by a
 * removed declaration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_FILE, parseDevVariableEntries } from "../dev-variables-format";
import type { InferredBindings } from "../infer-bindings";
import { packageNamesFromBindings } from "../infer-bindings";
import { requiredSecrets } from "../scaffold-dev-variables";
import type { ExportGap } from "./reconcile-bindings";
import type { WranglerShape } from "./wrangler-shape";

/**
 * Collect hint-only binding warnings. Each carries a remote id/name Lunora
 * can't mint (a KV namespace id, a Hyperdrive id, a Pipelines pipeline name);
 * like R2's user-defined bucket name they are warned, never auto-written, and
 * the warning is suppressed once the corresponding binding array is already
 * present so a wired-up project starts the dev server clean. Self-describing
 * bindings (browser/images/analytics) are auto-written instead; see reconcile.
 */
/** The one Pipelines binding name codegen resolves — `emitPipelinesFragments`'s `env.PIPELINES` fallback, which has no `defineApp` override. */
const PIPELINES_BINDING = "PIPELINES";

const collectHintBindingWarnings = (inferred: InferredBindings, parsed?: WranglerShape): string[] => {
    // A Flagship binding-mode provider needs a matching `flagship[]` entry; the
    // warning keys on the *binding name* (an app can wire several Flagship apps),
    // not array length, and carries the specific name + app_id remediation.
    const flagshipBindingMissing =
        inferred.flagshipBinding !== undefined && !(parsed?.flagship ?? []).some((entry) => entry.binding === inferred.flagshipBinding);

    // Keyed on the binding NAME for the same reason Flagship is, and one more:
    // codegen resolves ONE fixed name (`config.pipelines?.(env) ?? env.PIPELINES`)
    // and `pipelines` has no `defineApp` override to point elsewhere. So a
    // `{ "binding": "EVENTS" }` entry satisfies the array-length test and the
    // wrangler validator while `ctx.pipelines.send()` still throws at runtime —
    // with nothing before that ever naming PIPELINES. The KV and Hyperdrive
    // rules above stay on length: those bindings are passed to `createKv()` /
    // the Hyperdrive client by the app, so any name the app chose is correct.
    const pipelinesBindingMissing = inferred.usesPipelines && !(parsed?.pipelines ?? []).some((entry) => entry.binding === PIPELINES_BINDING);

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
            pipelinesBindingMissing,
            `ctx.pipelines is used but no "${PIPELINES_BINDING}" pipelines binding exists; run 'wrangler pipelines create <name>' and add a 'pipelines' binding ({ binding: "${PIPELINES_BINDING}", stream }) — codegen resolves this one name, and the pipeline resource can't be auto-provisioned.`,
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

/** Workflow/agent `exports.<Class>` (or legacy `workflows[]`) entries the emitted bundle no longer exports. */
const orphanedWorkflowWarnings = (inferred: InferredBindings, parsed: WranglerShape): string[] => {
    const declaredClasses = new Set([...inferred.workflows, ...inferred.agents].map((declaration) => declaration.className));

    if (declaredClasses.size === 0) {
        return [];
    }

    const exportedClasses = Object.entries(parsed.exports ?? {}).flatMap(([className, entry]) => (entry?.type === "workflow" ? [className] : []));
    // `flatMap` with an in-body guard rather than `filter().map()`: a filter
    // predicate does not narrow the element type for the map that follows.
    // A binding with `script_name` targets another Worker's workflow, not ours.
    const boundClasses = (parsed.workflows ?? []).flatMap((entry) =>
        entry.class_name === undefined || entry.script_name !== undefined ? [] : [entry.class_name],
    );

    return [...new Set([...exportedClasses, ...boundClasses])]
        .filter((className) => !declaredClasses.has(className))
        .map(
            (className) =>
                `wrangler.jsonc declares workflow "${className}" but no defineWorkflow/defineAgent export generates that class — a leftover from a rename will fail the deploy (wrangler rejects a class the worker does not export). Remove it if it is not hand-wired.`,
        );
};

/** Queue consumer/producer entries no `defineQueue` export declares. */
const orphanedQueueWarnings = (inferred: InferredBindings, parsed: WranglerShape): string[] => {
    if (inferred.queues.length === 0) {
        return [];
    }

    const declaredNames = new Set(inferred.queues.map((queue) => queue.name));
    const declaredBindings = new Set(inferred.queues.map((queue) => queue.bindingName));

    return [
        ...(parsed.queues?.consumers ?? []).flatMap((consumer) => {
            const { queue } = consumer;

            return queue === undefined || declaredNames.has(queue)
                ? []
                : [
                      `wrangler.jsonc subscribes queues.consumers[] to "${queue}" but no defineQueue export declares that queue — a leftover from a rename keeps delivering batches this worker has no handler for (they retry to exhaustion, then drop or dead-letter). Remove it if it is not hand-wired.`,
                  ];
        }),
        ...(parsed.queues?.producers ?? []).flatMap((producer) => {
            const { binding } = producer;

            return binding === undefined || declaredBindings.has(binding)
                ? []
                : [
                      `wrangler.jsonc declares queues.producers[] binding "${binding}" but no defineQueue export declares it — a leftover from a rename. Remove it if it is not hand-wired.`,
                  ];
        }),
    ];
};

/**
 * The `workflows[]` / `queues` entries in `wrangler.jsonc` that no longer match
 * any declaration — the leftovers a rename produces, since every reconcile step
 * here is **add-only** (it computes what is missing and appends it; it never
 * removes).
 *
 * Warned about rather than deleted, deliberately. Nothing in `wrangler.jsonc`
 * records which entries this tool wrote, so "unmatched" and "hand-written" are
 * indistinguishable — a project can export a Workflow class or handle a queue
 * itself without a `defineWorkflow` / `defineQueue` declaration, and silently
 * dropping those is exactly the over-eager clear the cron reconciler had to be
 * pulled back from. Establishing ownership needs a marker in the file, which is
 * a larger change than this.
 *
 * Each kind is inspected only when the project declares at least one of that
 * kind: with zero declarations there is no rename to infer, only a config this
 * tool has never had a reason to touch, and warning there would fire on every
 * dev-server boot of a hand-wired project. So a rename is caught and a
 * delete-the-last-one is not — stated here because it is the limit of what can
 * be told apart without ownership.
 *
 * Left behind, a stale `queues.consumers[]` subscription keeps delivering
 * batches to a worker that has no handler for that queue name
 * (`@lunora/queue`'s dispatch throws `no push handler is registered`, so the
 * batch retries to exhaustion and is then dropped or dead-lettered), and a
 * stale `workflows[]` entry names a `class_name` the bundle no longer exports,
 * which wrangler rejects at deploy.
 */
const orphanedEntryWarnings = (inferred: InferredBindings, parsed: WranglerShape): string[] => [
    ...orphanedWorkflowWarnings(inferred, parsed),
    ...orphanedQueueWarnings(inferred, parsed),
];

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

/**
 * A declared `secrets.required` list is an allow-list, not documentation:
 * `wrangler dev` loads only the listed keys from `.dev.vars`, and `wrangler
 * deploy` checks only those. A secret the detected packages need but the list
 * omits is therefore stripped in dev — the worker then throws on its first read
 * of it. Only checked when the list exists; without one wrangler loads every key.
 */
const missingRequiredSecretWarnings = (inferred: InferredBindings, parsed?: WranglerShape): string[] => {
    const required = parsed?.secrets?.required;

    if (!Array.isArray(required)) {
        return [];
    }

    const declared = new Set<unknown>(required);
    const missing = requiredSecrets(packageNamesFromBindings(inferred))
        .map((entry) => entry.key)
        .filter((key) => !declared.has(key));

    return missing.length === 0
        ? []
        : [
              `wrangler.jsonc declares secrets.required without ${missing.join(", ")}, which this app needs — wrangler dev loads only the listed keys from .dev.vars, so add ${missing.length === 1 ? "it" : "them"} to secrets.required.`,
          ];
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

    warnings.push(...collectX402Warnings(inferred), ...collectHintBindingWarnings(inferred, parsed), ...missingRequiredSecretWarnings(inferred, parsed));

    if (parsed !== undefined) {
        warnings.push(...orphanedEntryWarnings(inferred, parsed));
    }

    return warnings;
};

export default collectWarnings;
