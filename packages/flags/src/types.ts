import type { EvaluationContext, EvaluationDetails, Hook, JsonValue, Logger, Provider } from "@openfeature/server-sdk";

/**
 * The flag-evaluation surface spliced onto every Lunora `ctx` as `ctx.flags`
 * (query / mutation / action) by codegen when an app wires `@lunora/flags`.
 *
 * Every method resolves through the configured OpenFeature provider and **never
 * throws** — on a missing flag, type mismatch, provider error, or
 * misconfiguration it resolves with the supplied `defaultValue`. Use the
 * `details.*` variants when you need the full {@link EvaluationDetails} (reason,
 * variant, `errorCode`, `errorMessage`) alongside the value.
 *
 * The optional per-call `context` is merged on top of the default targeting
 * context (the `targetingKey` derived from `defineFlags({ identify })`), so a
 * call can add or override targeting attributes for that single evaluation.
 */
export interface LunoraFlags {
    /** Resolve a boolean flag (feature on/off). */
    boolean: (flagKey: string, defaultValue: boolean, context?: EvaluationContext) => Promise<boolean>;
    /** Full {@link EvaluationDetails} variants — value plus reason / variant / error metadata. */
    details: {
        boolean: (flagKey: string, defaultValue: boolean, context?: EvaluationContext) => Promise<EvaluationDetails<boolean>>;
        number: (flagKey: string, defaultValue: number, context?: EvaluationContext) => Promise<EvaluationDetails<number>>;
        object: <T extends JsonValue>(flagKey: string, defaultValue: T, context?: EvaluationContext) => Promise<EvaluationDetails<T>>;
        string: (flagKey: string, defaultValue: string, context?: EvaluationContext) => Promise<EvaluationDetails<string>>;
    };
    /** Resolve a number flag (rate limits, thresholds, percentages). */
    number: (flagKey: string, defaultValue: number, context?: EvaluationContext) => Promise<number>;
    /** Resolve an object/JSON flag (complex configuration). */
    object: <T extends JsonValue>(flagKey: string, defaultValue: T, context?: EvaluationContext) => Promise<T>;
    /** Resolve a string flag (A/B variants, copy experiments). */
    string: (flagKey: string, defaultValue: string, context?: EvaluationContext) => Promise<string>;
}

/**
 * The resolved request auth handed to {@link FlagsConfig.identify} so an app can
 * derive the default OpenFeature `targetingKey` (usually the authenticated user
 * id). This mirrors the `auth` shape the runtime already threads into other ctx
 * helpers, so `identify` never needs the full ctx.
 */
export interface FlagsAuth {
    /** The verified identity claims for the request, or `null` when anonymous. */
    identity: Record<string, unknown> | null;
    /** The authenticated user id for the request, or `null` when anonymous. */
    userId: string | null;
}

/**
 * Builds the OpenFeature {@link Provider} for the request from the Worker `env`.
 *
 * Receiving `env` (rather than a constructed provider) is what lets the Flagship
 * binding provider read `env.FLAGS` at request time — matching the existing
 * `config.ai?.(env)` thunk pattern. Construction is memoized per DO isolate, so
 * this factory is invoked once per isolate, not once per request.
 */
export type FlagsProviderFactory = (env: Record<string, unknown>) => Provider;

/** Options accepted by `defineFlags`. */
export interface FlagsConfig {
    /**
     * OpenFeature hooks run on every evaluation (logging, telemetry, …). Applied
     * to the Lunora flags client when the provider is bound.
     */
    hooks?: Hook[];

    /**
     * Derives the default OpenFeature `targetingKey` from the request auth. Most
     * apps return the user id: `identify: (auth) => auth.userId ?? undefined`.
     * A per-call `context.targetingKey` still overrides this.
     */
    identify?: (auth: FlagsAuth) => string | undefined;
    /** Logger for the OpenFeature client (provider + SDK diagnostics). */
    logger?: Logger;

    /**
     * The OpenFeature provider factory. Use `flagshipProvider(...)` from
     * `@lunora/flags/providers/flagship`, or return any OpenFeature provider:
     * `provider: (env) => new LaunchDarklyProvider(env.LD_KEY)`.
     */
    provider: FlagsProviderFactory;
}

/**
 * A branded {@link FlagsConfig} produced by `defineFlags`. This is the
 * default export of `lunora/flags.ts`; codegen imports it into the generated
 * worker and wires `ctx.flags` from its `provider` / `identify`.
 */
export interface FlagsDefinition extends FlagsConfig {
    /** Runtime brand used by `isFlagsDefinition` and codegen discovery. */
    readonly isLunoraFlags: true;
}
