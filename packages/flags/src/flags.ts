import { LunoraError } from "@lunora/errors";
import type { Client, EvaluationContext, EvaluationDetails, FlagValue, Provider } from "@openfeature/server-sdk";
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
 * Bind (or reuse) the OpenFeature client for one (definition, env) pair.
 * `provider` resolves the provider to bind — the definition's own factory,
 * unless a caller overrode it.
 *
 * The domain is allocated once per pair and SURVIVES a failed bind, so a
 * provider whose `initialize` throws retries on the same domain instead of
 * renaming it (which would strand an external reader on a dead domain). Only
 * the client promise is dropped on rejection, so the next request re-attempts.
 */
const bindClient = (definition: FlagsDefinition, env: object, provider: () => Provider): Promise<Client> => {
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
    pending.catch(() => {
        if (entry.client === pending) {
            entry.client = undefined;
        }
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
