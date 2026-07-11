import type { JsonValue, Provider, ResolutionDetails } from "@openfeature/server-sdk";
import { ErrorCode } from "@openfeature/server-sdk";

import type { FlagsProviderFactory } from "../types";

/** Options for {@link envProvider}. */
interface EnvProviderOptions {
    /**
     * Map a flag key to its Worker `env` variable name. Defaults to
     * `prefix` + the key upper-snake-cased (`"dark-mode"` → `"FLAG_DARK_MODE"`).
     * Provide this to override the whole derivation (the `prefix` is then unused).
     */
    name?: (flagKey: string) => string;
    /** Prefix prepended to the derived env variable name. Defaults to `"FLAG_"`. */
    prefix?: string;
}

/** `"dark-mode"` → `"DARK_MODE"`: collapse runs of non-alphanumerics to `_`, upper-case. */
const upperSnake = (flagKey: string): string => flagKey.replaceAll(/[^a-z0-9]+/gi, "_").toUpperCase();

const TRUE_TOKENS = new Set(["1", "on", "true", "yes"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off"]);

const staticDetails = <T>(value: T): Promise<ResolutionDetails<T>> => Promise.resolve({ reason: "STATIC", value });

/** A missing env var isn't an error — the flag simply falls back to its default. */
const missing = <T>(defaultValue: T): Promise<ResolutionDetails<T>> => Promise.resolve({ reason: "DEFAULT", value: defaultValue });

const parseError = <T>(defaultValue: T, message: string): Promise<ResolutionDetails<T>> =>
    Promise.resolve({ errorCode: ErrorCode.PARSE_ERROR, errorMessage: message, reason: "ERROR", value: defaultValue });

/**
 * A zero-dependency OpenFeature provider that reads flags from the Worker `env`
 * (plain `vars` and Secrets Store / `.dev.vars` values). Each flag key maps to an
 * env variable (default `"dark-mode"` → `env.FLAG_DARK_MODE`); the string value is
 * coerced to the read's type:
 *
 * - **boolean** — `true`/`1`/`on`/`yes` → `true`, `false`/`0`/`off`/`no` → `false` (case-insensitive), anything else is a parse error.
 * - **number** — `Number(value)`; non-numeric is a parse error.
 * - **string** — the raw value.
 * - **object** — `JSON.parse(value)`; invalid JSON is a parse error.
 *
 * A key with no matching env variable falls back to the call's default (reason
 * `DEFAULT`); a parse error also returns the default (reason `ERROR`) so a
 * malformed value degrades the read rather than throwing.
 *
 * ```ts
 * import { defineFlags } from "@lunora/flags";
 * import { envProvider } from "@lunora/flags/providers/env";
 *
 * // wrangler.jsonc: { "vars": { "FLAG_DARK_MODE": "true", "FLAG_PAGE_SIZE": "25" } }
 * export default defineFlags({ provider: envProvider() });
 * // ctx.flags.boolean("dark-mode", false) → true
 * // ctx.flags.number("page-size", 10)     → 25
 * ```
 *
 * Values are static per deployment (env is fixed for the isolate's lifetime), so
 * this suits build-time/per-environment toggles rather than live targeting.
 */
const envProvider = (options: EnvProviderOptions = {}): FlagsProviderFactory => {
    const prefix = options.prefix ?? "FLAG_";
    const nameOf = options.name ?? ((flagKey: string): string => prefix + upperSnake(flagKey));

    return (env: Record<string, unknown>): Provider => {
        const raw = (flagKey: string): string | undefined => {
            const value = env[nameOf(flagKey)];

            if (value === undefined || value === null) {
                return undefined;
            }

            if (typeof value === "string") {
                return value;
            }

            // Worker env values are strings in practice; coerce a primitive directly
            // and serialize anything structured so the typed reads can still parse it.
            if (typeof value === "number" || typeof value === "boolean") {
                return String(value);
            }

            return JSON.stringify(value);
        };

        return {
            metadata: { name: "lunora-env" },
            resolveBooleanEvaluation: (flagKey, defaultValue): Promise<ResolutionDetails<boolean>> => {
                const value = raw(flagKey);

                if (value === undefined) {
                    return missing(defaultValue);
                }

                const token = value.trim().toLowerCase();

                if (TRUE_TOKENS.has(token)) {
                    return staticDetails(true);
                }

                if (FALSE_TOKENS.has(token)) {
                    return staticDetails(false);
                }

                return parseError(defaultValue, `env flag "${flagKey}" (${nameOf(flagKey)}) value is not a recognized boolean`);
            },
            resolveNumberEvaluation: (flagKey, defaultValue): Promise<ResolutionDetails<number>> => {
                const value = raw(flagKey);

                if (value === undefined) {
                    return missing(defaultValue);
                }

                const parsed = Number(value);

                if (value.trim() === "" || Number.isNaN(parsed)) {
                    return parseError(defaultValue, `env flag "${flagKey}" (${nameOf(flagKey)}) value is not a number`);
                }

                return staticDetails(parsed);
            },
            resolveObjectEvaluation: <T extends JsonValue>(flagKey: string, defaultValue: T): Promise<ResolutionDetails<T>> => {
                const value = raw(flagKey);

                if (value === undefined) {
                    return missing(defaultValue);
                }

                try {
                    return staticDetails(JSON.parse(value) as T);
                } catch (error) {
                    return parseError(
                        defaultValue,
                        `env flag "${flagKey}" (${nameOf(flagKey)}) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            },
            resolveStringEvaluation: (flagKey, defaultValue): Promise<ResolutionDetails<string>> => {
                const value = raw(flagKey);

                return value === undefined ? missing(defaultValue) : staticDetails(value);
            },
        };
    };
};

export { envProvider };
export type { EnvProviderOptions };
