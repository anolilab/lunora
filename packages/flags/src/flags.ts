import { LunoraError } from "@lunora/errors";
import type { Client, EvaluationContext, EvaluationDetails, FlagValue, Hook, Logger, Provider } from "@openfeature/server-sdk";
import { ErrorCode, OpenFeature } from "@openfeature/server-sdk";

// Repo-root inlined helper (see shared/stable-key.ts) — the canonical
// code-point-stable, recursively-sorted cache-key encoder, so the flags memo
// keys match the client/react/do dedup semantics.
import { stableStringify } from "../../../shared/stable-key";
import type { LunoraFlags } from "./types";

/**
 * OpenFeature domain the Lunora flags client is bound under. A dedicated domain
 * keeps the flags provider isolated from any other OpenFeature usage in the same
 * isolate.
 */
const DOMAIN = "lunora";

/**
 * Per-isolate memo of the bound OpenFeature client. The provider is set +
 * initialized exactly once per DO isolate (not per request); subsequent requests
 * reuse this promise. A rejected bind (e.g. a provider whose `initialize` throws)
 * is cleared so the next request retries rather than failing forever.
 */
let clientBinding: Promise<Client> | undefined;

interface BindOptions {
    hooks?: Hook[];
    logger?: Logger;
    provider: () => Provider;
}

const bindClient = ({ hooks, logger, provider }: BindOptions): Promise<Client> => {
    if (clientBinding === undefined) {
        clientBinding = (async (): Promise<Client> => {
            await OpenFeature.setProviderAndWait(DOMAIN, provider());

            const client = OpenFeature.getClient(DOMAIN);

            if (logger) {
                client.setLogger(logger);
            }

            if (hooks && hooks.length > 0) {
                client.addHooks(...hooks);
            }

            return client;
        })();

        // Don't memoize a failed bind — let the next request re-attempt.
        clientBinding.catch(() => {
            clientBinding = undefined;
        });
    }

    return clientBinding;
};

/**
 * Drops the per-isolate client binding and clears OpenFeature's provider
 * registry. Test-only — production code never needs to unbind (the isolate owns
 * a single, static provider for its lifetime).
 */
const resetFlags = async (): Promise<void> => {
    clientBinding = undefined;

    await OpenFeature.clearProviders();
};

/** Options for `createFlags`. Built by codegen from `defineFlags(...)`. */
interface CreateFlagsOptions {
    /** OpenFeature hooks applied when the provider is bound. */
    hooks?: Hook[];
    /** Logger for the OpenFeature client. */
    logger?: Logger;
    /** Lazily constructs the OpenFeature provider from `env` (invoked once per isolate). */
    provider: () => Provider;

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
 * Builds the `ctx.flags` facade for a single request. Evaluations resolve
 * through the OpenFeature client (the SDK applies hooks and never throws —
 * provider errors surface as the default value with an `errorCode`). The default
 * `targetingKey` is merged under any per-call context, and identical evaluations
 * within the request are memoized so repeated reads of the same flag are
 * internally consistent and hit the provider once.
 */
const createFlags = (options: CreateFlagsOptions): LunoraFlags => {
    const { hooks, logger, provider, targetingKey } = options;

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
            bindClient({ hooks, logger, provider })
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
