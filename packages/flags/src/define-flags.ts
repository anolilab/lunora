import type { FlagsConfig, FlagsDefinition } from "./types";

/**
 * Declare the feature-flag provider for a Lunora app. Pure validation +
 * branding — codegen discovers the default export of `lunora/flags.ts`, imports
 * it into the generated worker, and wires `ctx.flags` from `provider` /
 * `identify` (mirrors how `defineQueue` / `defineWorkflow` feed codegen).
 *
 * ```ts
 * // lunora/flags.ts
 * import { defineFlags } from "@lunora/flags";
 * import { flagshipProvider } from "@lunora/flags/providers/flagship";
 *
 * export default defineFlags({
 *     provider: flagshipProvider({ binding: "FLAGS" }), // Cloudflare Flagship (binding mode)
 *     identify: (auth) => auth.userId ?? undefined,      // default targetingKey
 * });
 * ```
 *
 * Any OpenFeature provider works — Flagship is just the first-class default:
 *
 * ```ts
 * export default defineFlags({ provider: (env) => new SomeOpenFeatureProvider(env.SOME_KEY) });
 * ```
 */
const defineFlags = (config: FlagsConfig): FlagsDefinition => {
    if (typeof config.provider !== "function") {
        throw new TypeError('defineFlags: `provider` must be a function `(env) => Provider` (e.g. flagshipProvider({ binding: "FLAGS" }))');
    }

    if (config.identify !== undefined && typeof config.identify !== "function") {
        throw new TypeError("defineFlags: `identify` must be a function `(auth) => string | undefined` when provided");
    }

    if (config.hooks !== undefined && !Array.isArray(config.hooks)) {
        throw new TypeError("defineFlags: `hooks` must be an array of OpenFeature hooks when provided");
    }

    return { ...config, isLunoraFlags: true };
};

/** True when a value is a {@link defineFlags} result (the runtime brand check). */
const isFlagsDefinition = (value: unknown): value is FlagsDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraFlags?: unknown }).isLunoraFlags === true;

export { defineFlags, isFlagsDefinition };
