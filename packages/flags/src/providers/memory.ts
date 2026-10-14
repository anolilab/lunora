import type { JsonValue } from "@openfeature/server-sdk";
import { TypedInMemoryProvider } from "@openfeature/server-sdk";

import type { FlagsProviderFactory } from "../types";

/**
 * The value a static memory flag can hold — any JSON value (OpenFeature boolean /
 * number / string / structured object). Alias of `JsonValue` for naming clarity.
 */
type MemoryFlagValue = JsonValue;

/** OpenFeature's `FlagConfiguration` isn't exported; derive it from the constructor. */
type FlagConfiguration = NonNullable<ConstructorParameters<typeof TypedInMemoryProvider>[0]>;

/**
 * A static, in-memory OpenFeature provider for `defineFlags({ provider })`, built
 * on OpenFeature's own in-memory provider (no extra install). Pass a plain
 * `key → value` map; every read resolves the configured value (reason `STATIC`)
 * or, for an unknown key, the call's default.
 *
 * Ideal for tests, local development, and apps with a handful of static flags
 * checked into the repo — no external flag service, no binding.
 *
 * ```ts
 * import { defineFlags } from "@lunora/flags";
 * import { memoryProvider } from "@lunora/flags/providers/memory";
 *
 * export default defineFlags({
 *     provider: memoryProvider({
 *         "dark-mode": true,
 *         "page-size": 25,
 *         "homepage-hero": "control",
 *         "rollout": { percent: 10, regions: ["us", "eu"] },
 *     }),
 * });
 * ```
 *
 * Targeting (per-context variants) is out of scope for this static provider; for
 * that, wire a real provider (e.g. `flagshipProvider`) or construct a
 * `TypedInMemoryProvider` with `contextEvaluator`s directly via the `defineFlags`
 * escape hatch (`provider: () => new TypedInMemoryProvider(config)`).
 */
const memoryProvider = (flags: Record<string, MemoryFlagValue>): FlagsProviderFactory => {
    const configuration: FlagConfiguration = {};

    for (const [key, value] of Object.entries(flags)) {
        configuration[key] = {
            defaultVariant: "default",
            disabled: false,
            variants: { default: value },
        };
    }

    const provider = new TypedInMemoryProvider(configuration);

    // Static flags don't depend on the Worker env; reuse one provider per isolate.
    return (_environment: Record<string, unknown>): TypedInMemoryProvider => provider;
};

export { memoryProvider };
export type { MemoryFlagValue };
