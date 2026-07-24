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
 * build-time signal rather than a runtime surprise.
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

import type { PlatformCapabilities } from "@lunora/platform";
import { CLOUDFLARE_CAPABILITIES } from "@lunora/platform";

import type { CapabilityKey } from "./capabilities";
import type { FeatureUsage } from "./discover-feature-usage";

/** The default codegen target — today's behavior, byte-identical goldens. */
const DEFAULT_TARGET = "cloudflare";

/**
 * The capability matrices codegen can gate against, keyed by target id. One
 * entry per host package that ships a `PlatformCapabilities`; only Cloudflare
 * exists so far.
 */
const PLATFORM_MATRICES: Readonly<Record<string, PlatformCapabilities>> = {
    cloudflare: CLOUDFLARE_CAPABILITIES,
};

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
    /** Severity. `platform_unsupported_feature` and `platform_unknown_target` are both errors — each drops or misdirects an emitted surface. */
    level: "error" | "warn";
    /** Human-readable explanation of the gap. */
    message: string;
    /** The lint id: `platform_unsupported_feature` or `platform_unknown_target`. */
    name: "platform_unknown_target" | "platform_unsupported_feature";
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
export { DEFAULT_TARGET, gateAgainstMatrix, gatePlatformFeatures };
