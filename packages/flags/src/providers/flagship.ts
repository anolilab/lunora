import { FlagshipServerProvider } from "@cloudflare/flagship/server";
import { LunoraError } from "@lunora/errors";

import type { FlagsProviderFactory } from "../types";

/**
 * Flagship provider in **binding mode** (recommended for Workers): evaluations
 * go through the wrangler binding — no HTTP, no auth token.
 */
interface FlagshipBindingOptions {
    /**
     * The name of the Flagship binding on the Worker `env` (e.g. `"FLAGS"`). The
     * factory resolves `env[binding]` at request time. Configure a matching
     * `flagship` binding in `wrangler.jsonc` with this binding name and your app id.
     */
    binding: string;
    /** Max cached entries when `cacheTtl` is set (default 1000). */
    cacheMaxSize?: number;
    /** Opt-in per-context TTL cache, in ms. Enables caching when greater than 0. */
    cacheTtl?: number;
    /** Surface Flagship SDK logs (default false). */
    logging?: boolean;
}

/**
 * Flagship provider in **HTTP mode** (non-binding Workers or other server
 * runtimes): evaluations go to the Flagship API over HTTP.
 */
interface FlagshipHttpOptions {
    /** Account id for multi-tenant routing (required with `appId`). */
    accountId?: string;
    /** Flagship app id; the SDK builds the evaluation URL (mutually exclusive with `endpoint`). */
    appId?: string;

    /**
     * Bearer token added as an `Authorization: Bearer` header to every request.
     * Either the literal token, or a thunk resolved against the Worker `env` at
     * construction (`(env) => env.FLAGSHIP_TOKEN`) so the secret never has to be
     * inlined in source. A thunk resolving to anything but a non-empty string
     * throws: `Bearer undefined` would otherwise make every evaluation fall
     * silently back to its default.
     */
    authToken?: ((env: Record<string, unknown>) => unknown) | string;
    /** Base URL override (only used with `appId`). */
    baseUrl?: string;
    cacheMaxSize?: number;
    cacheTtl?: number;
    /** Full evaluation URL (mutually exclusive with `appId`). */
    endpoint?: string;
    logging?: boolean;
    /** Retry attempts on transient errors (default 1, max 10). */
    retries?: number;
    /** Delay between retries in ms (default 1000, max 30000). */
    retryDelay?: number;
    /** Request timeout in ms (default 5000). */
    timeout?: number;
}

/** Options for `flagshipProvider` — binding mode or HTTP mode. */
type FlagshipProviderOptions = FlagshipBindingOptions | FlagshipHttpOptions;

const isBindingOptions = (options: FlagshipProviderOptions): options is FlagshipBindingOptions => "binding" in options && typeof options.binding === "string";

/**
 * Builds a Cloudflare Flagship OpenFeature provider for `defineFlags({ provider })`.
 * Flagship is Lunora's first-class default; the same `defineFlags` accepts any
 * OpenFeature provider, so apps can swap it out without touching call sites.
 *
 * ```ts
 * // Binding mode (recommended) — reads env.FLAGS at request time:
 * flagshipProvider({ binding: "FLAGS" })
 *
 * // HTTP mode — the token is a literal, or a thunk read off the Worker env:
 * flagshipProvider({ appId: "app-abc", accountId: "acct", authToken: "tok" })
 * flagshipProvider({ appId: "app-abc", accountId: "acct", authToken: (env) => env.FLAGSHIP_TOKEN })
 * ```
 */
const flagshipProvider = (options: FlagshipProviderOptions): FlagsProviderFactory => {
    if (isBindingOptions(options)) {
        const { binding: bindingName, ...rest } = options;

        return (env: Record<string, unknown>): FlagshipServerProvider => {
            const binding = env[bindingName];

            if (binding === undefined || binding === null) {
                throw new LunoraError(
                    "INTERNAL",
                    `flagshipProvider: no binding "${bindingName}" found on env. Add a \`flagship\` binding to wrangler.jsonc, ` +
                        `e.g. { "flagship": [{ "binding": "${bindingName}", "app_id": "your-app-id" }] }.`,
                );
            }

            return new FlagshipServerProvider({ binding: binding as never, ...rest });
        };
    }

    // HTTP mode carries no env-resolved binding, so — unlike binding mode — the
    // full config is known here. Validate it up front: a misconfiguration must
    // surface as a directed error at `defineFlags` time, not get swallowed into
    // silent fail-closed defaults by `createFlags` (which buries any provider
    // construction/initialize failure in `EvaluationDetails.errorMessage`).
    const { appId, endpoint } = options;

    if (appId === undefined && endpoint === undefined) {
        throw new LunoraError(
            "INTERNAL",
            "flagshipProvider: HTTP mode requires either `appId` (the SDK builds the evaluation URL) or `endpoint` (a full evaluation URL). " +
                'Pass exactly one, or use binding mode: `flagshipProvider({ binding: "FLAGS" })`.',
        );
    }

    if (appId !== undefined && endpoint !== undefined) {
        throw new LunoraError("INTERNAL", "flagshipProvider: `appId` and `endpoint` are mutually exclusive in HTTP mode — pass exactly one.");
    }

    // Defer construction to the factory so the isolate-level memo owns its
    // lifetime — and so an `authToken` thunk can read the Worker `env`, which is
    // the only place a deployment's secret exists.
    const { authToken, ...rest } = options;

    return (env: Record<string, unknown>): FlagshipServerProvider => {
        if (typeof authToken !== "function") {
            return new FlagshipServerProvider({ ...rest, ...(authToken === undefined ? {} : { authToken }) });
        }

        // A thunk was written to supply a token, so resolving to nothing is a
        // misconfigured deployment, not "no auth": the unset secret would go out
        // as `Bearer undefined` and every evaluation would fail closed to its
        // default with no signal. Only an OMITTED `authToken` means "no token".
        const resolved = authToken(env);

        if (typeof resolved !== "string" || resolved.length === 0) {
            throw new LunoraError(
                "INTERNAL",
                "flagshipProvider: `authToken` resolved to an empty or non-string value — check that the env var the thunk reads is set. " +
                    "An unset secret would send `Bearer undefined`, and every evaluation would silently fall back to its default.",
            );
        }

        return new FlagshipServerProvider({ ...rest, authToken: resolved });
    };
};

export { flagshipProvider };
export type { FlagshipBindingOptions, FlagshipHttpOptions, FlagshipProviderOptions };
