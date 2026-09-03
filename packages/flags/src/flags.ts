import { LunoraError } from "@lunora/errors";
import type { Client, EvaluationContext, EvaluationDetails, FlagValue, Logger, Provider } from "@openfeature/server-sdk";
import { ErrorCode, OpenFeature } from "@openfeature/server-sdk";

// Repo-root inlined helper (see shared/stable-key.ts) — the canonical
// code-point-stable, recursively-sorted cache-key encoder, so the flags memo
// keys match the client/react/do dedup semantics.
import { stableStringify } from "../../../shared/stable-key";
import type { FlagsDefinition, LunoraFlags } from "./types";

/**
 * OpenFeature domain the FIRST bound (definition, env) pair gets — the only
 * case a real app hits, since a Worker isolate has one `lunora/flags.ts` and
 * one `env`. Keeping the name stable means an external
 * `OpenFeature.getClient("lunora")` reader still sees the app's provider.
 * Additional pairs (a second definition, or a second env in tests) get
 * `lunora-2`, `lunora-3`, … — see {@link bindClient}.
 *
 * Which pair wins the unsuffixed name is therefore ALLOCATION-ORDER dependent:
 * if a test seam or a second env binds first, the app's own definition lands on
 * `lunora-2` and an external reader of `"lunora"` reads the wrong provider.
 * Nothing in this repo reads the domain by name, and "first *definition* wins"
 * would be just as order-dependent, so the order-dependence is documented
 * rather than papered over. Code that must address a specific client should be
 * handed the client, not look it up by domain.
 */
const DEFAULT_DOMAIN = "lunora";

/**
 * One binding per (definition, env) pair: the OpenFeature domain it owns and
 * the in-flight/settled client promise for it.
 */
interface Binding {
    client?: Promise<Client>;
    readonly domain: string;
}

/**
 * Per-isolate memo of bound OpenFeature clients, keyed on the
 * {@link FlagsDefinition} identity (a module singleton — the `lunora/flags.ts`
 * default export) then the Worker `env`, both stable for the isolate's
 * lifetime. `WeakMap`s so a torn-down definition/env is collectable and tests
 * using fresh objects never leak state into each other (mirrors
 * `@lunora/notify`'s runtime cache).
 *
 * Each pair also owns its own OpenFeature DOMAIN. That is what makes the
 * isolation real: OpenFeature's provider registry is global per domain, so
 * binding two definitions under one shared domain would leave the first
 * definition's cached client silently evaluating against the second's
 * provider. Per-pair domains mean a client always resolves through the
 * provider, logger, and hooks it was bound with.
 */
let clientCache = new WeakMap<FlagsDefinition, WeakMap<object, Binding>>();

/** Bindings allocated so far — numbers the suffixed domains (see {@link DEFAULT_DOMAIN}). */
let boundCount = 0;

/**
 * Stand-in identity for an `env` carrying no bindings.
 *
 * Generated workers build their env as `this.env ?? {}`, so a nullish `env`
 * yields a FRESH object on every context build. Keyed on that, each request
 * would miss the cache and bind a new `lunora-N` domain — and OpenFeature's
 * registry holds a STRONG reference to every provider it is given, so the
 * WeakMap being weak would not release them. Two envs with no bindings are
 * indistinguishable to any provider factory anyway, so they share one key.
 */
const EMPTY_ENV: Record<string, never> = {};

/** The identity an env is memoized under (see {@link EMPTY_ENV}). */
const envKeyFor = (env: object): object => (Object.keys(env).length === 0 ? EMPTY_ENV : env);

/**
 * Report a provider bind that failed — the ONE place this package is allowed to
 * be loud.
 *
 * Every evaluation is contractually silent: `ctx.flags.*` never throws, and a
 * provider error resolves with the caller's `defaultValue`. That is right for an
 * evaluation and wrong for a bind, because a bind fails for exactly one reason —
 * the deployment is misconfigured (`flagshipProvider`'s missing `FLAGS` binding,
 * its `authToken` thunk resolving to nothing, a provider `initialize` that
 * throws) — and the resulting fleet-wide fallback to checked-in defaults is
 * invisible in every other signal. The error is reachable per-evaluation via
 * `ctx.flags.details.*().errorMessage`, but nothing reads that on the path a
 * kill-switch is written on.
 *
 * The definition's own `logger` is preferred (it is where the app already sends
 * OpenFeature diagnostics); `console.error` is the fallback, since a Worker with
 * no logger configured still has a tail. `client.setLogger` cannot serve here —
 * it runs only after a bind SUCCEEDS.
 *
 * Fires once per failed bind attempt, and bind attempts are coalesced per
 * (definition, env) pair while one is in flight, so a broken deployment logs on
 * the order of once per request rather than once per flag read.
 */
const reportBindFailure = (logger: Logger | undefined, error: unknown): void => {
    const message = `@lunora/flags: could not bind the OpenFeature provider — every flag read falls back to its caller-supplied default until this is fixed: ${
        error instanceof Error ? error.message : String(error)
    }`;

    if (logger) {
        logger.error(message);

        return;
    }

    // eslint-disable-next-line no-console -- a misconfigured flag provider silently serving checked-in defaults fleet-wide is worth a Worker tail line
    console.error(message);
};

/**
 * Bind (or reuse) the OpenFeature client for one (definition, env) pair.
 * `provider` resolves the provider to bind — the definition's own factory,
 * unless a caller overrode it.
 *
 * The domain is allocated once per pair and SURVIVES a failed bind, so a
 * provider whose `initialize` throws retries on the same domain instead of
 * renaming it (which would strand an external reader on a dead domain). Only
 * the client promise is dropped on rejection, so the next request re-attempts.
 *
 * A rejected bind is REPORTED (see {@link reportBindFailure}). Evaluations
 * still fail closed to the caller's default — that is the OpenFeature contract
 * `ctx.flags` documents — but they must not do it silently: a deployment missing
 * its `flagship` binding, or whose `FLAGSHIP_TOKEN` is unset, otherwise boots
 * clean and serves every kill-switch and rollout at its checked-in default
 * across the whole fleet with nothing to notice.
 */
const bindClient = (definition: FlagsDefinition, rawEnv: object, provider: () => Provider): Promise<Client> => {
    const env = envKeyFor(rawEnv);

    let byEnv = clientCache.get(definition);

    if (byEnv === undefined) {
        byEnv = new WeakMap<object, Binding>();
        clientCache.set(definition, byEnv);
    }

    let binding = byEnv.get(env);

    if (binding === undefined) {
        boundCount += 1;
        binding = { domain: boundCount === 1 ? DEFAULT_DOMAIN : `${DEFAULT_DOMAIN}-${String(boundCount)}` };
        byEnv.set(env, binding);
    }

    if (binding.client !== undefined) {
        return binding.client;
    }

    const entry = binding;
    const { domain } = entry;
    const { hooks, logger } = definition;

    const pending = (async (): Promise<Client> => {
        await OpenFeature.setProviderAndWait(domain, provider());

        const client = OpenFeature.getClient(domain);

        if (logger) {
            client.setLogger(logger);
        }

        if (hooks && hooks.length > 0) {
            client.addHooks(...hooks);
        }

        return client;
    })();

    entry.client = pending;

    // Don't memoize a failed bind — let the next request re-attempt. Guarded on
    // identity so a reset-then-rebind is never clobbered by a stale rejection.
    pending.catch((error: unknown) => {
        if (entry.client === pending) {
            entry.client = undefined;
        }

        reportBindFailure(logger, error);
    });

    return pending;
};

/**
 * Drops every memoized client binding and clears OpenFeature's provider
 * registry. Test-only — production code never needs to unbind (a definition and
 * env live as long as their isolate).
 */
const resetFlags = async (): Promise<void> => {
    clientCache = new WeakMap();
    boundCount = 0;

    await OpenFeature.clearProviders();
};

/**
 * Per-request extras for `createFlags`. Everything static — the provider
 * factory, `hooks`, `logger` — is read from the {@link FlagsDefinition} itself,
 * so this carries only what the definition cannot know: the test/config
 * provider override and the request's targeting key.
 */
interface CreateFlagsOptions {
    /**
     * Overrides the definition's provider (codegen's `config.flags` test seam).
     * Returning `undefined` falls back to `definition.provider(env)`.
     */
    provider?: () => Provider | undefined;

    /**
     * Default `targetingKey` for every evaluation (from `defineFlags({ identify })`).
     * May be a thunk — codegen passes one wrapping the user's `identify` — so a
     * throwing `identify` fails open to no `targetingKey` rather than escaping
     * ctx construction and taking down the whole request.
     */
    targetingKey?: (() => string | undefined) | string;
}

type FlagType = "boolean" | "number" | "object" | "string";

/**
 * Stable memo key over the evaluation's type, key, default, and context.
 *
 * The context portion is encoded with the repo's canonical `stableStringify`
 * (shared/stable-key.ts) so object keys are sorted at *every* depth: two
 * logically identical contexts that differ only in (possibly nested) key order
 * — `{ org: { id, plan } }` vs `{ org: { plan, id } }` — collapse to one key, so
 * repeated reads of the same flag hit the provider once and stay internally
 * consistent. The common empty-context case short-circuits to a constant `{}`
 * suffix (equal to `stableStringify({})`) instead of recursing.
 *
 * `stableStringify` throws on a value it can't faithfully encode (a `bigint`, a
 * circular reference, or a non-plain object such as a `Date` — all of which
 * `EvaluationContext` structurally permits). Callers wrap this in try/catch and
 * fall back to an unmemoized evaluation, keeping the never-throws contract.
 */
const memoKey = (type: FlagType, flagKey: string, defaultValue: FlagValue, context: EvaluationContext): string => {
    const prefix = stableStringify([type, flagKey, defaultValue]);

    if (Object.keys(context).length === 0) {
        return `${prefix}:{}`;
    }

    return `${prefix}:${stableStringify(context)}`;
};

/** Dispatch one evaluation to the matching typed OpenFeature client method. */
const resolveDetails = (
    client: Client,
    type: FlagType,
    flagKey: string,
    defaultValue: FlagValue,
    context: EvaluationContext,
): Promise<EvaluationDetails<FlagValue>> => {
    switch (type) {
        case "boolean": {
            return client.getBooleanDetails(flagKey, defaultValue as boolean, context);
        }
        case "number": {
            return client.getNumberDetails(flagKey, defaultValue as number, context);
        }
        case "object": {
            return client.getObjectDetails(flagKey, defaultValue, context);
        }
        case "string": {
            return client.getStringDetails(flagKey, defaultValue as string, context);
        }
        default: {
            throw new LunoraError("INTERNAL", `createFlags: unknown flag type "${type as string}"`);
        }
    }
};

/**
 * Builds the `ctx.flags` facade for a single request. The provider, `hooks`,
 * and `logger` come from `definition`; the client bind is memoized per
 * (`definition`, `env`) pair — both stable object identities for the isolate's
 * lifetime — and each pair owns its own OpenFeature domain, so a pair always
 * evaluates against the provider it was configured with instead of whichever
 * bind happened first. Evaluations resolve through the
 * OpenFeature client (the SDK applies hooks and never throws — provider errors
 * surface as the default value with an `errorCode`). The default `targetingKey`
 * is merged under any per-call context, and identical evaluations within the
 * request are memoized so repeated reads of the same flag are internally
 * consistent and hit the provider once.
 */
const createFlags = (definition: FlagsDefinition, env: Record<string, unknown>, options: CreateFlagsOptions = {}): LunoraFlags => {
    const { provider: providerOverride, targetingKey } = options;
    const provider = (): Provider => providerOverride?.() ?? definition.provider(env);

    // Resolve the default targetingKey once. A user-supplied `identify` thunk
    // that throws must not propagate — fail open to no targetingKey so a buggy
    // `identify` degrades the flag read instead of failing the whole request.
    let resolvedTargetingKey: string | undefined;

    try {
        resolvedTargetingKey = typeof targetingKey === "function" ? targetingKey() : targetingKey;
    } catch {
        resolvedTargetingKey = undefined;
    }

    const memo = new Map<string, Promise<EvaluationDetails<FlagValue>>>();

    const evaluate = <T extends FlagValue>(type: FlagType, flagKey: string, defaultValue: T, context?: EvaluationContext): Promise<EvaluationDetails<T>> => {
        const merged: EvaluationContext = resolvedTargetingKey === undefined ? { ...context } : { targetingKey: resolvedTargetingKey, ...context };

        // Fail closed to the default value. The OpenFeature client itself never
        // throws, but binding the provider can (a failed `initialize`).
        const failClosed = (error: unknown): EvaluationDetails<FlagValue> => {
            return {
                errorCode: ErrorCode.GENERAL,
                errorMessage: error instanceof Error ? error.message : String(error),
                flagKey,
                flagMetadata: {},
                reason: "ERROR",
                value: defaultValue,
            };
        };

        const run = (): Promise<EvaluationDetails<FlagValue>> =>
            bindClient(definition, env, provider)
                .then((client) => resolveDetails(client, type, flagKey, defaultValue, merged))
                .catch(failClosed);

        // Computing the memo key serializes the merged context. A context value
        // that can't be encoded — a circular reference, a `bigint`, a non-plain
        // object like a `Date` — makes `memoKey` throw *synchronously*, before any
        // async boundary. Contain it and evaluate without memoization so
        // `ctx.flags.*` upholds its documented never-throws contract.
        let key: string;

        try {
            key = memoKey(type, flagKey, defaultValue, merged);
        } catch {
            return run() as Promise<EvaluationDetails<T>>;
        }

        const cached = memo.get(key);

        if (cached) {
            return cached as Promise<EvaluationDetails<T>>;
        }

        const pending = run();

        memo.set(key, pending);

        return pending as Promise<EvaluationDetails<T>>;
    };

    return {
        boolean: (flagKey, defaultValue, context) => evaluate("boolean", flagKey, defaultValue, context).then((details) => details.value),
        details: {
            boolean: (flagKey, defaultValue, context) => evaluate("boolean", flagKey, defaultValue, context),
            number: (flagKey, defaultValue, context) => evaluate("number", flagKey, defaultValue, context),
            object: (flagKey, defaultValue, context) => evaluate("object", flagKey, defaultValue, context),
            string: (flagKey, defaultValue, context) => evaluate("string", flagKey, defaultValue, context),
        },
        number: (flagKey, defaultValue, context) => evaluate("number", flagKey, defaultValue, context).then((details) => details.value),
        object: (flagKey, defaultValue, context) => evaluate("object", flagKey, defaultValue, context).then((details) => details.value),
        string: (flagKey, defaultValue, context) => evaluate("string", flagKey, defaultValue, context).then((details) => details.value),
    };
};

export { createFlags, resetFlags };
export type { CreateFlagsOptions };
