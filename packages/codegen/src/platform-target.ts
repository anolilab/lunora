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
 * Only Cloudflare is registered today (its matrix lives in `@lunora/platform`);
 * other hosts register their matrices as their per-target `@lunora/platform`
 * host packages land. Until then a non-Cloudflare `target` is a configuration error,
 * reported as `platform_unknown_target` — and, crucially, the usage set is left
 * untouched so codegen never silently omits a surface against a matrix it does
 * not have.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PlatformCapabilities } from "@lunora/platform";
import { CLOUDFLARE_CAPABILITIES } from "@lunora/platform";
import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import type { CapabilityKey } from "./capabilities";
import type { FeatureUsage } from "./discover-feature-usage";

/** The default codegen target — today's behavior, byte-identical goldens. */
const DEFAULT_TARGET = "cloudflare";

/** The project-config file the target is declared in. Same file `@lunora/config` reads for `remote`. */
const PROJECT_CONFIG_FILE = "lunora.json";

/**
 * Read `target` from `&lt;projectRoot>/lunora.json`.
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
 * entry per host package that ships a `PlatformCapabilities`; only Cloudflare
 * exists so far.
 */
const PLATFORM_MATRICES: Readonly<Record<string, PlatformCapabilities>> = {
    cloudflare: CLOUDFLARE_CAPABILITIES,
};

/**
 * The target ids codegen can gate against.
 *
 * Exported so `@lunora/config` can assert that its driver registry and this
 * capability-matrix registry name the same targets. They are two id spaces for one
 * concept: a target that ships a driver but no matrix passes the CLI's
 * validation and then emits an un-gated surface, and one with a matrix but no
 * driver gates a surface nothing can deploy. Today both hold exactly
 * `cloudflare`, which is why nothing has noticed.
 * @returns the registered matrix ids, sorted.
 */
const platformMatrixIds = (): ReadonlyArray<string> => Object.keys(PLATFORM_MATRICES).toSorted((a, b) => a.localeCompare(b));

/** A platform feature key in the `@lunora/platform` capability matrix. */
type PlatformFeatureKey = keyof PlatformCapabilities["features"];

/**
 * Map a codegen {@link CapabilityKey} to the `@lunora/platform` feature that
 * decides whether a target supports it. A key with no entry is an
 * app-level add-on with no platform-portability meaning (feature flags, the
 * Cloudflare-Access identity facade, Cloudflare Images, R2 SQL, payments,
 * x402) — never gated, always emitted, on every target.
 */
const CAPABILITY_TO_FEATURE: Partial<Record<CapabilityKey, PlatformFeatureKey>> = {
    ai: "ai",
    analytics: "analytics",
    browser: "browser",
    container: "containers",
    hyperdrive: "hyperdrive",
    kv: "keyValueStore",
    mail: "mail",
    pipelines: "pipelines",
    scheduler: "scheduler",
    storage: "objectStorage",
    vectors: "vectorStore",
    workflows: "workflows",
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
    /** A copy of the usage set with unsupported features flipped off. */
    usage: FeatureUsage;
}

/**
 * Gate `usage` against an explicit {@link PlatformCapabilities} matrix — the
 * core intersection {@link gatePlatformFeatures} runs once it has resolved the
 * target to a matrix. Split out so it can be exercised against any matrix
 * (including targets whose host packages don't exist yet) without reaching
 * through the registry.
 */
const gateAgainstMatrix = (usage: FeatureUsage, matrix: PlatformCapabilities, target: string): PlatformGateResult => {
    const gated: FeatureUsage = { ...usage };
    const diagnostics: PlatformDiagnostic[] = [];

    for (const [capability, featureKey] of Object.entries(CAPABILITY_TO_FEATURE) as [CapabilityKey, PlatformFeatureKey][]) {
        if (!usage[capability]) {
            continue;
        }

        const level = matrix.features[featureKey]?.level;

        if (level === "unsupported") {
            gated[capability] = false;
            diagnostics.push({
                feature: capability,
                level: "error",
                message: `${matrix.name} does not support "${capability}" (ctx.${capability}). Its surface was omitted from the generated types.`,
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
            diagnostics.push({
                feature: capability,
                level: "error",
                message: `${matrix.name}'s capability matrix does not declare a support level for "${capability}" (ctx.${capability}). Treated as unsupported and its surface was omitted from the generated types.`,
                name: "platform_undeclared_feature",
                remediation: `Rate "${featureKey}" in the ${matrix.name} capability matrix as "native", "emulated", or "unsupported" — an undeclared feature fails closed rather than shipping a surface the host may not provide.`,
                target,
            });
        }
    }

    return { diagnostics, usage: gated };
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
const gatePlatformFeatures = (usage: FeatureUsage, target: string): PlatformGateResult => {
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
            usage: { ...usage },
        };
    }

    return gateAgainstMatrix(usage, matrix, target);
};

export type { PlatformDiagnostic, PlatformGateResult };
export { DEFAULT_TARGET, gateAgainstMatrix, gatePlatformFeatures, platformMatrixIds, PROJECT_CONFIG_FILE, readProjectTarget, resolveCodegenTarget };
