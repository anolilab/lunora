/**
 * Target-awareness for codegen (plan 114, §5.5).
 *
 * Codegen emits the same `ctx.*` surface regardless of where the app deploys.
 * That is correct for Cloudflare — the reference target, whose capability
 * matrix marks every feature `native` or `emulated` — but a different host may
 * not provide a given primitive at all. This module intersects what the app
 * uses (the {@link FeatureUsage} probe) with what the target supports (its
 * `@lunora/platform` {@link PlatformCapabilities} matrix): a feature the app
 * uses that the target marks `unsupported` is dropped from the emitted surface
 * and reported as a {@link PlatformDiagnostic}, so a portability gap is a
 * build-time signal rather than a runtime surprise. A feature the app uses
 * that the matrix does not rate AT ALL — every `features` key is optional —
 * is treated the same way (dropped, diagnosed) rather than left in: an
 * un-rated feature fails closed under its own `platform_undeclared_feature`
 * name, so a partial matrix from a WIP second host cannot silently emit a
 * surface for a primitive it never claimed to support.
 *
 * `native` and `emulated` both emit as-is — `emulated` means Lunora builds the
 * feature on lower-level primitives, which is still a working surface.
 *
 * Cloudflare, Node, and celld are registered (their matrices live in
 * `@lunora/platform` as `CLOUDFLARE_CAPABILITIES` / `NODE_CAPABILITIES` /
 * `CELLD_CAPABILITIES`); other hosts register their matrices as their
 * per-target `@lunora/platform-<target>` packages land.
 * An unregistered `target` is a configuration error, reported as
 * `platform_unknown_target` — and, crucially, the usage set is left untouched
 * so codegen never silently omits a surface against a matrix it does not have.
 *
 * `node` is registered here, and `@lunora/config`'s driver registry now
 * registers a `NODE_DRIVER` too — so `platformMatrixIds()` and
 * `deployTargetIds()` agree again. They are still not the SAME question:
 * "codegen can gate capabilities for this target" and "the CLI can deploy to
 * it" are answered by different registries, and a host can legitimately answer
 * the first before the second (which is what `node` did while its matrix landed
 * ahead of its driver). Asserting equality between the two id spaces would make
 * the next such host a test failure rather than a normal intermediate state,
 * which is why `project-config.test.ts` keeps the relaxed assertion.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PlatformCapabilities } from "@lunora/platform";
import { CELLD_CAPABILITIES, CLOUDFLARE_CAPABILITIES, NODE_CAPABILITIES } from "@lunora/platform";
import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import type { CapabilityKey } from "./capabilities";
import type { FeatureUsage } from "./discover/feature-usage";

/** The default codegen target — today's behavior, byte-identical goldens. */
const DEFAULT_TARGET = "cloudflare";

/** The project-config file the target is declared in. Same file `@lunora/config` reads for `remote`. */
const PROJECT_CONFIG_FILE = "lunora.json";

/**
 * Read `target` from `<projectRoot>/lunora.json`.
 *
 * This lives in `@lunora/codegen` rather than `@lunora/config` — where the rest
 * of the `lunora.json` reading lives — because `@lunora/config` depends on
 * `@lunora/codegen`, not the reverse. Putting it there and importing it here
 * would invert that edge, so config delegates to this instead and there is
 * still exactly one parser for the key.
 *
 * Best-effort and deliberately unvalidated: a missing file, malformed JSONC, or
 * a non-string value all collapse to `undefined`, because those are shape
 * errors rather than a name the user meant. An unrecognized *name* is returned
 * as-is so the caller's registry lookup rejects it — swallowing a typo into the
 * default would ship an app to the wrong provider.
 * @param projectRoot Directory containing `lunora.json`.
 * @returns the declared target, or `undefined` when none is usable.
 */
const readProjectTarget = (projectRoot: string): string | undefined => {
    const configPath = join(projectRoot, PROJECT_CONFIG_FILE);

    if (!existsSync(configPath)) {
        return undefined;
    }

    let text: string;

    try {
        text = readFileSync(configPath, "utf8");
    } catch {
        return undefined;
    }

    const parseErrors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });

    if (parseErrors.length > 0 || parsed === null || typeof parsed !== "object") {
        return undefined;
    }

    const { target } = parsed as { target?: unknown };

    return typeof target === "string" && target.length > 0 ? target : undefined;
};

/**
 * The target codegen should emit for: an explicit option wins, then
 * `lunora.json`, then the default.
 *
 * `runCodegen` applies this itself so a caller that forgets to pass a target
 * still emits the surface the project declared. That default matters more than
 * it looks: a call site that silently omits the target emits the *default*
 * surface with no diagnostic to notice, and the mismatch only shows up at
 * runtime on the deployed app.
 * @param projectRoot Directory containing `lunora.json`.
 * @param explicit A caller-supplied target, if any.
 * @returns the resolved target id — not guaranteed to be registered.
 */
const resolveCodegenTarget = (projectRoot: string, explicit?: string): string => explicit ?? readProjectTarget(projectRoot) ?? DEFAULT_TARGET;

/**
 * The capability matrices codegen can gate against, keyed by target id. One
 * entry per host package that ships a `PlatformCapabilities` — Cloudflare and
 * Node, both of which also ship a `@lunora/config` deploy driver, plus celld
 * (see `@lunora/platform-celld`), a spike host with no deploy story of its own
 * — celld apps deploy through `celld deploy`.
 */
const PLATFORM_MATRICES: Readonly<Record<string, PlatformCapabilities>> = {
    celld: CELLD_CAPABILITIES,
    cloudflare: CLOUDFLARE_CAPABILITIES,
    node: NODE_CAPABILITIES,
};

/**
 * The target ids codegen can gate against.
 *
 * `@lunora/config`'s driver registry (`deployTargetIds`) used to assert
 * equality against this — "two id spaces for one concept" — on the theory that
 * a target with a matrix but no driver "gates a surface nothing can deploy."
 * Both registries list `cloudflare` and `node` today, so they happen to agree;
 * the assertion stays relaxed because agreement is a coincidence of timing, not
 * an invariant. "Codegen can gate capabilities for this target" and "the CLI can
 * deploy to it" are different questions, and a new host answers the first the
 * moment its capability matrix lands — before its deploy driver exists. See
 * `@lunora/config`'s `project-config.test.ts` for where that relaxed invariant
 * lives.
 * @returns the registered matrix ids, sorted.
 */
const platformMatrixIds = (): ReadonlyArray<string> => Object.keys(PLATFORM_MATRICES).toSorted((a, b) => a.localeCompare(b));

/** A platform feature key in the `@lunora/platform` capability matrix. */
type PlatformFeatureKey = keyof PlatformCapabilities["features"];

/**
 * Map a codegen {@link CapabilityKey} to the `@lunora/platform` feature that
 * decides whether a target supports it. The criterion for an entry is the
 * transport: a capability backed by a host **binding** is mapped and gated —
 * a target without the binding fails at runtime, so codegen must omit the
 * surface and emit `platform_unsupported_feature` instead. A key with no
 * entry is **credential-based** (genuinely target-agnostic): it works
 * anywhere `fetch` works, given an API token, so it is never gated and
 * always emitted, on every target — feature flags (`flags`), the
 * Cloudflare-Access identity facade (`access`), payments (`payments`), and
 * x402 (`x402`). `r2sql` is deliberately unmapped for the same reason: the
 * R2 SQL client is a plain HTTP client over an API token, not a binding.
 * `notify` is unmapped on the same criterion, and the contrast with `mail` —
 * which IS mapped — is what makes the line concrete: `@lunora/mail` holds a
 * Queue binding itself (`createMailer({ queue })`, and `mailer.queue()`
 * throws without one), so a target without queues cannot serve its surface.
 * `@lunora/notify` holds nothing: Web Push and FCM delivery are `fetch` under
 * VAPID/FCM credentials, the subscription store is a caller-supplied
 * `(env) => SubscriptionStore` that falls back to an in-memory one (and the
 * shipped D1 store is structurally typed, never a `D1Database` import), and
 * the fan-out seam takes the producer as an argument (`QueueProducerLike`) so
 * the queue belongs to the caller, not to `ctx.notify`.
 *
 * Credential-based is spelled `null`, not omission, and the map is TOTAL
 * (`Record`, not `Partial`). That is the whole enforcement: adding a member to
 * `CapabilityKey` without classifying it here fails `tsc`, at the moment it is
 * written, rather than defaulting silently to un-gated. An earlier revision kept
 * the unmapped keys in a second list with a test asserting the two partitioned
 * `CapabilityKey` — same guarantee, but deferred to CI and costing a list, two
 * exports and a test to say what the type already says.
 *
 * `access` stays unmapped even though the matrix now rates `identityProxy`,
 * and the distinction is the point: `identityProxy` records whether the *host*
 * can hand the runtime a pre-authenticated identity out-of-band, while the
 * `ctx.access` facade `access` gates works on any target, because
 * `@lunora/cloudflare-access` falls back to verifying the
 * `Cf-Access-Jwt-Assertion` header — a plain HTTP check needing no host
 * support. Gating the facade on the rating would drop a surface that still
 * functions.
 *
 * `shardAlarms` is deliberately unmapped here, and not because it was
 * forgotten: `CapabilityKey` is derived from `CAPABILITY_ROWS`, which
 * enumerates app-imported `ctx.*` add-on modules, and there is no such usage
 * key for alarms because they are an engine-internal contract member, never
 * something an app imports. There is nothing for this map to gate on. Its
 * `PlatformCapabilities` rating still matters for Studio parity reporting and
 * any future target-level check — see its `shardAlarms` entry in the Node
 * capability matrix (`NODE_CAPABILITIES` in `@lunora/platform`, plan 267).
 */
const CAPABILITY_TO_FEATURE: Record<CapabilityKey, PlatformFeatureKey | null> = {
    // eslint-disable-next-line unicorn/no-null -- null is the classification "credential-based"; undefined would be indistinguishable from an unclassified key, which is what this map exists to prevent
    access: null,
    ai: "ai",
    analytics: "analytics",
    browser: "browser",
    container: "containers",
    // eslint-disable-next-line unicorn/no-null -- see `access`
    flags: null,
    hyperdrive: "hyperdrive",
    images: "images",
    kv: "keyValueStore",
    mail: "mail",
    // eslint-disable-next-line unicorn/no-null -- see `access`
    notify: null,
    // eslint-disable-next-line unicorn/no-null -- see `access`
    payments: null,
    pipelines: "pipelines",
    // eslint-disable-next-line unicorn/no-null -- see `access`
    r2sql: null,
    scheduler: "scheduler",
    storage: "objectStorage",
    vectors: "vectorStore",
    workflows: "workflows",
    // eslint-disable-next-line unicorn/no-null -- see `access`
    x402: null,
};

/**
 * The app-declarable platform features that have NO `ctx.*` capability row, and
 * so no {@link CAPABILITY_TO_FEATURE} entry to gate them.
 *
 * `CapabilityKey` is derived from `CAPABILITY_ROWS`, which enumerates
 * the app-imported `ctx.*` add-on modules. Everything an app declares some other
 * way — a `.global()` table, a `defineQueue`, a `.shardBy(...)` schema, a
 * `.stream(h, { durable: true })`, a `ctx.secrets` read, a `cronJobs()`
 * registration, a `.vectorize()` index, a `defineAgent` export — was rated in
 * every capability matrix and then consulted by nothing: on `target: "node"` a
 * durable stream emitted its full surface with no diagnostic and silently
 * behaved as ephemeral, and a declared cron deployed green and never fired.
 *
 * Two of these keys are ALSO reachable through a capability (`vectorStore` via
 * `ctx.vectors`, and `cronTriggers` sits beside — not under — `scheduler`,
 * which rates the imperative `ctx.scheduler` surface only). That is why the
 * second pass skips a feature the first already reported, and why declaring a
 * cron is rated separately from enqueueing a job: a host can dispatch what the
 * app enqueues at runtime and still walk nothing into its declared crons.
 *
 * Each key here IS the `PlatformCapabilities["features"]` key, because there is
 * no capability indirection to go through. Unset/`false` means "the app does not
 * declare it", which is never gated.
 */
interface PlatformSignals {
    /** A `defineAgent` export in `lunora/agents.ts`. */
    agents?: boolean;
    /** A `.commitOrdered()` table. */
    commitOrderedTables?: boolean;
    /** A `cronJobs()` registration. */
    cronTriggers?: boolean;
    /** A `.shardBy(...)` schema — clients can address non-default shards, so the coordinator can fan out across them. */
    crossShardFanout?: boolean;
    /** A `.stream(handler, { durable: … })` registration. */
    durableStreams?: boolean;
    /** A `.global()` table. */
    globalTables?: boolean;
    /** A `defineQueue` declaration. */
    queues?: boolean;
    /** A `ctx.secrets` read. */
    secrets?: boolean;
    /** A `.vectorize()` / `defineVectorIndex` declaration in the schema. */
    vectorStore?: boolean;
}

/** The {@link PlatformSignals} keys, for the second gate loop. */
const PLATFORM_SIGNAL_KEYS = [
    "agents",
    "commitOrderedTables",
    "cronTriggers",
    "crossShardFanout",
    "durableStreams",
    "globalTables",
    "queues",
    "secrets",
    "vectorStore",
] as const;

/** Human-readable name for each signal, for the diagnostic message. */
const PLATFORM_SIGNAL_LABELS: Readonly<Record<keyof PlatformSignals, string>> = {
    agents: "durable agents (`defineAgent`)",
    commitOrderedTables: "commit-ordered tables (`.commitOrdered()`)",
    cronTriggers: "declared cron triggers (`cronJobs()`)",
    crossShardFanout: "cross-shard fan-out queries (a `.shardBy(...)` schema)",
    durableStreams: "durable streams (`.stream(handler, { durable: true })`)",
    globalTables: "global tables (`.global()`)",
    queues: "queues (`defineQueue`)",
    secrets: "the secrets store (`ctx.secrets`)",
    vectorStore: "vector indexes (`.vectorize()`)",
};

/** An advisor-style diagnostic about a target's platform capabilities. */
interface PlatformDiagnostic {
    /** The codegen capability this concerns, when it is feature-specific. */
    feature?: CapabilityKey;
    /** Severity. All three names are errors — each drops or misdirects an emitted surface. */
    level: "error" | "warn";
    /** Human-readable explanation of the gap. */
    message: string;
    /** The lint id: `platform_unsupported_feature`, `platform_undeclared_feature`, or `platform_unknown_target`. */
    name: "platform_undeclared_feature" | "platform_unknown_target" | "platform_unsupported_feature";
    /** How to resolve it. */
    remediation: string;
    /** The requested deploy target. */
    target: string;
}

/** The gated usage set plus the diagnostics the gate produced. */
interface PlatformGateResult {
    /** The diagnostics — empty for a fully-supported app on a known target. */
    diagnostics: PlatformDiagnostic[];

    /**
     * A copy of the {@link PlatformSignals} input with every rejected signal
     * flipped to `false` — declared, but on a target that rates it `unsupported`
     * or does not rate it at all.
     *
     * The signals pass cannot omit a surface the way the capability pass does
     * (the app's own declaration is the source, not a generated `ctx.*` field),
     * so this is how an emitter driven by an IR array — `ctx.vectors` off
     * `schema.vectorIndexes` is the standing example — can still consult the
     * gate instead of emitting a surface the host cannot back. An absent key
     * means the app never declared it, which is not the same as rejected.
     */
    signals: PlatformSignals;
    /** A copy of the usage set with unsupported features flipped off. */
    usage: FeatureUsage;
}

/** The app declares this feature and the target rates it `unsupported`. */
const unsupportedSignalDiagnostic = (key: keyof PlatformSignals, matrix: PlatformCapabilities, target: string): PlatformDiagnostic => {
    return {
        level: "error",
        message: `${matrix.name} does not support ${PLATFORM_SIGNAL_LABELS[key]}, which this app declares.`,
        name: "platform_unsupported_feature",
        remediation: `Remove the declaration, or deploy to a target whose capability matrix marks "${key}" as native or emulated.`,
        target,
    };
};

/** The app declares this feature and the target's matrix rates it not at all — the fail-closed arm. */
const undeclaredSignalDiagnostic = (key: keyof PlatformSignals, matrix: PlatformCapabilities, target: string): PlatformDiagnostic => {
    return {
        level: "error",
        message: `${matrix.name}'s capability matrix does not declare a support level for ${PLATFORM_SIGNAL_LABELS[key]}, which this app declares. Treated as unsupported.`,
        name: "platform_undeclared_feature",
        remediation: `Rate "${key}" in the ${matrix.name} capability matrix as "native", "emulated", or "unsupported" — an undeclared feature fails closed rather than letting the app deploy onto a primitive the host may not provide.`,
        target,
    };
};

/**
 * The second gate pass: features an app DECLARES in its schema or a declaration
 * file, which have no `ctx.*` capability row for the first pass to notice.
 *
 * Lifted out of `gateAgainstMatrix` so that function stays readable — the two
 * passes answer different questions off different inputs, and only the shared
 * `reported` set couples them.
 */
const gateSignalPass = (context: {
    diagnostics: PlatformDiagnostic[];
    gatedSignals: PlatformSignals;
    matrix: PlatformCapabilities;
    reported: Set<string>;
    signals: PlatformSignals;
    target: string;
}): void => {
    const { diagnostics, gatedSignals, matrix, reported, signals, target } = context;

    for (const key of PLATFORM_SIGNAL_KEYS) {
        if (signals[key] !== true) {
            continue;
        }

        const level = matrix.features[key]?.level;

        if (level !== "unsupported" && level !== undefined) {
            continue;
        }

        // Reject FIRST, then decide whether to say so. `reported` suppresses a
        // duplicate DIAGNOSTIC for a feature reachable both as a capability and
        // as a signal — it must never suppress the rejection itself. Skipping
        // the whole iteration left `gatedSignals[key]` at `true`, so an app that
        // BOTH declares `.vectorize()` AND reads `ctx.vectors` had the surface
        // emitted anyway: the capability pass reported it, the signal pass saw
        // `reported.has(key)` and bailed before recording the rejection, and
        // `hasVectors` read the stale `true`. That is the more common shape —
        // you rarely declare a vector index without querying it — so the gate
        // was off in exactly the case it exists for.
        gatedSignals[key] = false;

        if (reported.has(key)) {
            continue;
        }

        diagnostics.push(level === "unsupported" ? unsupportedSignalDiagnostic(key, matrix, target) : undeclaredSignalDiagnostic(key, matrix, target));
    }
};

/**
 * Gate `usage` against an explicit {@link PlatformCapabilities} matrix — the
 * core intersection {@link gatePlatformFeatures} runs once it has resolved the
 * target to a matrix. Split out so it can be exercised against any matrix
 * (including targets whose host packages don't exist yet) without reaching
 * through the registry.
 */
const gateAgainstMatrix = (usage: FeatureUsage, matrix: PlatformCapabilities, target: string, signals: PlatformSignals = {}): PlatformGateResult => {
    const gated: FeatureUsage = { ...usage };
    const gatedSignals: PlatformSignals = { ...signals };
    const diagnostics: PlatformDiagnostic[] = [];
    // Feature keys already reported by the capability pass. A key can be reached
    // BOTH ways — `vectorStore` is a capability (`ctx.vectors`) and a schema
    // signal (`.vectorize()`) — and one unsupported feature is one problem, so
    // the second pass stays quiet about what the first already said.
    const reported = new Set<PlatformFeatureKey>();

    for (const [capability, featureKey] of Object.entries(CAPABILITY_TO_FEATURE) as [CapabilityKey, PlatformFeatureKey | null][]) {
        // A `null` feature is the declared "credential-based" classification: the
        // surface works anywhere `fetch` does, so there is no host rating to gate on.
        if (featureKey === null || !usage[capability]) {
            continue;
        }

        const level = matrix.features[featureKey]?.level;

        if (level === "unsupported") {
            gated[capability] = false;
            reported.add(featureKey);
            diagnostics.push({
                feature: capability,
                level: "error",
                // Deliberately does NOT claim the surface was omitted. That was
                // true for the capabilities whose emission this gate's `usage`
                // drives, and false for the ones emitted off an IR array
                // instead (`container`, `workflows`, `vectors`, `storage`,
                // `scheduler`) — a diagnostic that describes an omission that
                // did not happen is worse than one that only states the gap.
                message: `${matrix.name} does not support "${capability}" (ctx.${capability}).`,
                name: "platform_unsupported_feature",
                remediation: `Remove the ctx.${capability} usage, or deploy to a target whose capability matrix marks "${featureKey}" as native or emulated.`,
                target,
            });
        } else if (level === undefined) {
            // Every `features` key is optional (`Capability | undefined`), so a
            // matrix that OMITS a key — the shape a WIP second host ships while its
            // capability matrix is still partial — would otherwise fall through
            // this `if` entirely and leave `gated` (and the emitted surface)
            // untouched: fail OPEN. An omitted rating is not evidence of support,
            // so it is treated the same as an explicit `"unsupported"` for gating
            // purposes, but reported under its own name — the fix is different
            // (rate the feature) from an explicit unsupported (remove the usage or
            // change target), and collapsing them would send the wrong remediation.
            gated[capability] = false;
            reported.add(featureKey);
            diagnostics.push({
                feature: capability,
                level: "error",
                message: `${matrix.name}'s capability matrix does not declare a support level for "${capability}" (ctx.${capability}). Treated as unsupported.`,
                name: "platform_undeclared_feature",
                remediation: `Rate "${featureKey}" in the ${matrix.name} capability matrix as "native", "emulated", or "unsupported" — an undeclared feature fails closed rather than shipping a surface the host may not provide.`,
                target,
            });
        }
    }

    // Second pass: the app-declarable features with no `ctx.*` capability row
    // (see {@link PlatformSignals}). There is no `usage` flag to flip — a
    // `.global()` table or a durable stream is the app's own declaration, not a
    // generated surface codegen can omit — so the diagnostic IS the whole
    // output. Same fail-closed treatment of an undeclared rating as above.
    gateSignalPass({ diagnostics, gatedSignals, matrix, reported, signals, target });

    return { diagnostics, signals: gatedSignals, usage: gated };
};

/**
 * Intersect the app's {@link FeatureUsage} with the target's capability matrix.
 *
 * For the default Cloudflare target — whose matrix marks nothing `unsupported`
 * — this returns the usage set unchanged and no diagnostics, so emission (and
 * therefore the golden fixtures) is byte-identical. For a target that marks a
 * used feature `unsupported`, that feature is flipped off in the returned usage
 * (so the downstream `has*` flags omit its `ctx.*` surface) and a
 * `platform_unsupported_feature` diagnostic is recorded. An unknown target has
 * no matrix to gate against, so the surface is left intact and a
 * `platform_unknown_target` diagnostic is the signal.
 */
const gatePlatformFeatures = (usage: FeatureUsage, target: string, signals: PlatformSignals = {}): PlatformGateResult => {
    const matrix = PLATFORM_MATRICES[target];

    if (matrix === undefined) {
        return {
            diagnostics: [
                {
                    level: "error",
                    message: `Unknown deploy target "${target}" — no capability matrix is registered for it. Codegen emitted the full Cloudflare surface un-gated.`,
                    name: "platform_unknown_target",
                    remediation: `Use a registered target (${Object.keys(PLATFORM_MATRICES).join(", ")}) or install the target's @lunora/platform-${target} package.`,
                    target,
                },
            ],
            signals: { ...signals },
            usage: { ...usage },
        };
    }

    return gateAgainstMatrix(usage, matrix, target, signals);
};

export type { PlatformDiagnostic, PlatformGateResult, PlatformSignals };
export {
    CAPABILITY_TO_FEATURE,
    DEFAULT_TARGET,
    gateAgainstMatrix,
    gatePlatformFeatures,
    platformMatrixIds,
    PROJECT_CONFIG_FILE,
    readProjectTarget,
    resolveCodegenTarget,
};
