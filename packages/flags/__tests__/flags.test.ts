import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from "@openfeature/server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineFlags } from "../src/define-flags";
import { createFlags, resetFlags } from "../src/flags";

/**
 * A minimal in-memory OpenFeature provider for driving `createFlags`. Records
 * the contexts it was evaluated with (for targeting + memoization assertions)
 * and lets a test force an evaluation or initialization failure.
 */
interface FakeProvider extends Provider {
    readonly contexts: EvaluationContext[];
    readonly counts: Record<string, number>;
}

const makeProvider = (values: Record<string, JsonValue>, options: { initFails?: boolean; resolveThrows?: boolean } = {}): FakeProvider => {
    const contexts: EvaluationContext[] = [];
    const counts: Record<string, number> = {};

    const resolve = async <T>(flagKey: string, defaultValue: T, context: EvaluationContext): Promise<ResolutionDetails<T>> => {
        counts[flagKey] = (counts[flagKey] ?? 0) + 1;
        contexts.push(context);

        if (options.resolveThrows) {
            throw new Error("provider boom");
        }

        if (!(flagKey in values)) {
            return { reason: "DEFAULT", value: defaultValue };
        }

        return { reason: "TARGETING_MATCH", value: values[flagKey] as T, variant: "on" };
    };

    return {
        contexts,
        counts,
        initialize: options.initFails ? (): Promise<void> => Promise.reject(new Error("init boom")) : (): Promise<void> => Promise.resolve(),
        metadata: { name: "fake" },
        resolveBooleanEvaluation: (flagKey, defaultValue, context) => resolve(flagKey, defaultValue, context),
        resolveNumberEvaluation: (flagKey, defaultValue, context) => resolve(flagKey, defaultValue, context),
        resolveObjectEvaluation: (flagKey, defaultValue, context) => resolve(flagKey, defaultValue, context),
        resolveStringEvaluation: (flagKey, defaultValue, context) => resolve(flagKey, defaultValue, context),
        runsOn: "server",
    };
};

/**
 * Stable identity keys for the client memo, standing in for the generated
 * worker's `lunora/flags.ts` default export and its Worker `env`. Tests below
 * drive values through the `options.provider` override (codegen's
 * `config.flags` seam); the keyed-memo suite exercises the definition's own
 * provider instead.
 */
const definition = defineFlags({ provider: () => makeProvider({}) });
const env: Record<string, unknown> = {};

describe("createFlags", () => {
    afterEach(async () => {
        await resetFlags();
        vi.restoreAllMocks();
    });

    it("resolves each flag type through the provider", async () => {
        expect.assertions(4);

        const provider = makeProvider({
            "max-uploads": 25,
            "ui-config": { theme: "dark" },
            welcome: "hi",
            "dark-mode": true,
        });
        const flags = createFlags(definition, env, { provider: () => provider });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
        await expect(flags.string("welcome", "fallback")).resolves.toBe("hi");
        await expect(flags.number("max-uploads", 5)).resolves.toBe(25);
        await expect(flags.object("ui-config", { theme: "light" })).resolves.toEqual({ theme: "dark" });
    });

    it("returns the default value for an unknown flag", async () => {
        expect.assertions(2);

        const provider = makeProvider({});
        const flags = createFlags(definition, env, { provider: () => provider });

        await expect(flags.boolean("missing", false)).resolves.toBe(false);
        await expect(flags.string("missing", "default")).resolves.toBe("default");
    });

    it("exposes full evaluation details via details.*", async () => {
        expect.assertions(4);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        const details = await flags.details.boolean("dark-mode", false);

        expect(details.value).toBe(true);
        expect(details.reason).toBe("TARGETING_MATCH");
        expect(details.variant).toBe("on");
        expect(details.flagKey).toBe("dark-mode");
    });

    it("merges the default targetingKey under per-call context", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider, targetingKey: "user-123" });

        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.contexts[0]).toMatchObject({ plan: "premium", targetingKey: "user-123" });
    });

    it("lets a per-call targetingKey override the default", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider, targetingKey: "user-123" });

        await flags.boolean("dark-mode", false, { targetingKey: "user-999" });

        expect(provider.contexts[0]?.targetingKey).toBe("user-999");
    });

    it("resolves a targetingKey thunk (codegen passes one wrapping identify)", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider, targetingKey: () => "user-123" });

        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.contexts[0]).toMatchObject({ plan: "premium", targetingKey: "user-123" });
    });

    it("fails open to no targetingKey when the thunk throws (a buggy identify)", async () => {
        expect.assertions(2);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, {
            provider: () => provider,
            targetingKey: () => {
                throw new Error("identify blew up");
            },
        });

        // The throw must not propagate — the read still resolves, just without a targetingKey.
        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
        expect(provider.contexts[0]?.targetingKey).toBeUndefined();
    });

    it("memoizes identical evaluations within a request (one provider call)", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        await Promise.all([flags.boolean("dark-mode", false), flags.boolean("dark-mode", false), flags.boolean("dark-mode", false)]);

        expect(provider.counts["dark-mode"]).toBe(1);
    });

    it("does not share memo across different contexts", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        await flags.boolean("dark-mode", false, { plan: "free" });
        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.counts["dark-mode"]).toBe(2);
    });

    it("does not share memo across a NaN vs null context value (plan 355 regression)", async () => {
        expect.assertions(1);

        // Before plan 355, `stableStringify` encoded every non-finite number the
        // same as `null` (`JSON.stringify(NaN) === "null"`), so these two
        // semantically different contexts collapsed to one memo key and the
        // second read silently served the first's cached decision.
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        await flags.boolean("dark-mode", false, { score: Number.NaN });
        await flags.boolean("dark-mode", false, { score: null });

        expect(provider.counts["dark-mode"]).toBe(2);
    });

    it("returns the same in-flight promise for identical calls (memo hit, not just equal values)", async () => {
        expect.assertions(2);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        const [first, second] = [flags.details.boolean("dark-mode", false), flags.details.boolean("dark-mode", false)];

        expect(first).toBe(second);

        await Promise.all([first, second]);

        expect(provider.counts["dark-mode"]).toBe(1);
    });

    it("does not share memo across different flag keys with an empty context (no false cache hits)", async () => {
        expect.assertions(2);

        const provider = makeProvider({ "dark-mode": true, "beta-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        await Promise.all([flags.boolean("dark-mode", false), flags.boolean("beta-mode", false)]);

        expect(provider.counts["dark-mode"]).toBe(1);
        expect(provider.counts["beta-mode"]).toBe(1);
    });

    it("shares the memo across nested context objects that differ only in key order (recursive stable key)", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        // Logically identical contexts, nested keys in different orders. The
        // canonical stable-key encoder sorts at every depth, so both collapse to
        // one memo key and the provider is hit exactly once.
        await Promise.all([
            flags.boolean("dark-mode", false, { org: { id: "o1", plan: "pro" } }),
            flags.boolean("dark-mode", false, { org: { plan: "pro", id: "o1" } }),
        ]);

        expect(provider.counts["dark-mode"]).toBe(1);
    });

    it("never throws on an unserializable context (circular reference) — evaluates without memoization", async () => {
        expect.assertions(2);

        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags(definition, env, { provider: () => provider });

        // A circular context makes the memo-key serialization throw synchronously.
        // The read must still resolve (never-throws contract) by skipping the memo.
        const circular: Record<string, unknown> = { plan: "premium" };
        circular.self = circular;

        await expect(flags.boolean("dark-mode", false, circular as EvaluationContext)).resolves.toBe(true);

        // A second call with the same unkeyable context also skips the memo, so the
        // provider is hit again rather than a stale/errored value being returned.
        await flags.boolean("dark-mode", false, circular as EvaluationContext);

        expect(provider.counts["dark-mode"]).toBe(2);
    });

    it("does not share memo across different default values for the same flag key", async () => {
        expect.assertions(1);

        const provider = makeProvider({});
        const flags = createFlags(definition, env, { provider: () => provider });

        await Promise.all([flags.string("welcome", "a"), flags.string("welcome", "b")]);

        expect(provider.counts.welcome).toBe(2);
    });

    it("never throws when the provider errors — resolves the default with an errorCode", async () => {
        expect.assertions(4);

        const provider = makeProvider({ "dark-mode": true }, { resolveThrows: true });
        const flags = createFlags(definition, env, { provider: () => provider });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(false);

        const details = await flags.details.boolean("dark-mode", false);

        expect(details.value).toBe(false);
        expect(details.reason).toBe("ERROR");
        expect(details.errorCode).toBeDefined();
    });

    it("fails closed to the default when provider construction throws", async () => {
        expect.assertions(1);

        const flags = createFlags(definition, env, {
            provider: () => {
                throw new Error("no binding");
            },
        });

        await expect(flags.boolean("dark-mode", true)).resolves.toBe(true);
    });

    // Failing closed to the default is the OpenFeature contract and stays. Doing
    // it SILENTLY is the defect: a deployment whose `flagship` binding was never
    // added — or whose `FLAGSHIP_TOKEN` is unset — boots normally and serves every
    // kill-switch and rollout at its checked-in default across the whole fleet,
    // with no thrown error and no log line. `client.setLogger` runs only AFTER a
    // successful bind, so the user's own logger never saw a failed one.
    it("reports a failed provider bind through the definition's logger", async () => {
        expect.assertions(3);

        const error = vi.fn<(...arguments_: unknown[]) => void>();
        const noop = (): void => {};
        const logged = defineFlags({
            logger: { debug: noop, error, info: noop, warn: noop },
            provider: () => {
                throw new Error('no binding "FLAGS" found on env');
            },
        });

        await expect(createFlags(logged, env).boolean("kill-switch", true)).resolves.toBe(true);

        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0]?.[0])).toContain('no binding "FLAGS" found on env');
    });

    it("reports a failed provider bind on the console when no logger is configured", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const unlogged = defineFlags({
            provider: () => {
                throw new Error("authToken resolved to an empty or non-string value");
            },
        });

        await expect(createFlags(unlogged, env).boolean("kill-switch", true)).resolves.toBe(true);

        expect(consoleError).toHaveBeenCalledTimes(1);
    });

    it("retries the bind on a later request after a failed construction", async () => {
        expect.assertions(3);

        // The per-isolate binding is cleared on a failed bind, so a *subsequent*
        // request (a fresh createFlags + memo) re-attempts construction.
        let attempts = 0;
        const good = makeProvider({ "dark-mode": true });
        const provider = () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("transient");
            }
            return good;
        };

        await expect(createFlags(definition, env, { provider }).boolean("dark-mode", false)).resolves.toBe(false); // first bind fails → default
        await expect(createFlags(definition, env, { provider }).boolean("dark-mode", false)).resolves.toBe(true); // second request rebinds
        expect(attempts).toBe(2);
    });

    // The reporter is the ONE place this package is loud, and its only call site
    // is a `.catch()` on a floating promise — so an app logger that throws turned
    // the report into an unhandled rejection. Reporting must never change
    // control flow: the evaluation still fails closed and the failure still
    // reaches a tail.
    it("survives a logger that throws while reporting a failed bind", async () => {
        expect.assertions(3);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const unhandled = vi.fn<(reason: unknown) => void>();

        process.on("unhandledRejection", unhandled);

        const noop = (): void => {};
        const hostile = defineFlags({
            logger: {
                debug: noop,
                error: () => {
                    throw new Error("logger exploded");
                },
                info: noop,
                warn: noop,
            },
            provider: () => {
                throw new Error('no binding "FLAGS" found on env');
            },
        });

        try {
            await expect(createFlags(hostile, env).boolean("kill-switch", true)).resolves.toBe(true);

            // Let any rejection settle onto the microtask queue and past the
            // turn where Node would report it as unhandled.
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(unhandled).not.toHaveBeenCalled();
            // The throwing logger falls through to the console, so the
            // misconfiguration is still visible rather than swallowed twice.
            expect(consoleError).toHaveBeenCalledTimes(1);
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });

    // The generated `evaluateFlags` reads flags one `await` at a time. Because a
    // failed bind is dropped from the per-isolate memo so the NEXT request can
    // retry, each sequential read used to start its own bind — one provider
    // `initialize` and one log line per flag, not per request.
    it("attempts one bind per request across sequential reads of distinct flags", async () => {
        expect.assertions(4);

        const error = vi.fn<(...arguments_: unknown[]) => void>();
        const noop = (): void => {};
        let attempts = 0;
        const broken = defineFlags({
            logger: { debug: noop, error, info: noop, warn: noop },
            provider: () => {
                attempts += 1;

                throw new Error('no binding "FLAGS" found on env');
            },
        });

        const flags = createFlags(broken, env);

        await expect(flags.boolean("kill-switch", true)).resolves.toBe(true);
        await expect(flags.boolean("new-checkout", false)).resolves.toBe(false);
        await expect(flags.string("tier", "free")).resolves.toBe("free");

        expect([attempts, error.mock.calls.length]).toStrictEqual([1, 1]);
    });
});

describe("keyed client memo", () => {
    afterEach(async () => {
        await resetFlags();
        vi.restoreAllMocks();
    });

    it("binds once per definition + env pair", async () => {
        expect.assertions(1);

        const provider = makeProvider({ "dark-mode": true });
        const factory = vi.fn<() => Provider>(() => provider);
        const definitionA = defineFlags({ provider: factory });

        await createFlags(definitionA, env).boolean("dark-mode", false);
        await createFlags(definitionA, env).boolean("dark-mode", false);

        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("keeps each definition on its own provider — a later bind never hijacks an earlier client", async () => {
        expect.assertions(3);

        // The regression this keying exists for: under one shared OpenFeature
        // domain, definition B's `setProviderAndWait` would replace A's provider
        // in the global registry and A's cached client would silently start
        // evaluating B's values.
        const providerA = makeProvider({ "dark-mode": true });
        const providerB = makeProvider({ "dark-mode": false });
        const definitionA = defineFlags({ provider: () => providerA });
        const definitionB = defineFlags({ provider: () => providerB });

        const flagsA = createFlags(definitionA, env);

        await expect(flagsA.boolean("dark-mode", false)).resolves.toBe(true);
        await expect(createFlags(definitionB, env).boolean("dark-mode", true)).resolves.toBe(false);
        // A re-read AFTER B bound still resolves through A's provider.
        await expect(createFlags(definitionA, env).boolean("dark-mode", false)).resolves.toBe(true);
    });

    it("keeps each env on its own provider under one definition", async () => {
        expect.assertions(2);

        const definitionEnvAware = defineFlags({
            provider: (candidate) => makeProvider({ "dark-mode": candidate.DARK === "on" }),
        });

        await expect(createFlags(definitionEnvAware, { DARK: "on" }).boolean("dark-mode", false)).resolves.toBe(true);
        await expect(createFlags(definitionEnvAware, { DARK: "off" }).boolean("dark-mode", true)).resolves.toBe(false);
    });

    it("uses the options provider override when one is supplied (codegen's config.flags seam)", async () => {
        expect.assertions(2);

        const fromDefinition = vi.fn<() => Provider>(() => makeProvider({ "dark-mode": false }));
        const definitionOverridden = defineFlags({ provider: fromDefinition });

        const flags = createFlags(definitionOverridden, env, { provider: () => makeProvider({ "dark-mode": true }) });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
        expect(fromDefinition).not.toHaveBeenCalled();
    });

    it("falls back to the definition's provider when the override returns undefined", async () => {
        expect.assertions(1);

        const definitionFallback = defineFlags({ provider: () => makeProvider({ "dark-mode": true }) });
        const flags = createFlags(definitionFallback, env, { provider: () => undefined });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
    });

    it("applies the definition's hooks and logger to the bound client", async () => {
        expect.assertions(2);

        const before = vi.fn<() => undefined>(() => undefined);
        const logger = { debug: vi.fn<() => undefined>(), error: vi.fn<() => undefined>(), info: vi.fn<() => undefined>(), warn: vi.fn<() => undefined>() };
        const definitionHooked = defineFlags({
            hooks: [{ before }],
            logger,
            provider: () => makeProvider({ "dark-mode": true }),
        });

        await createFlags(definitionHooked, env).boolean("dark-mode", false);

        expect(before).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("binds once across context builds that each pass a fresh empty env", async () => {
        expect.assertions(1);

        // Generated workers build `this.env ?? {}`, so a nullish env yields a
        // NEW object per context build. Keyed on that, every request would bind
        // a fresh OpenFeature domain and the registry — which holds providers
        // strongly — would grow without bound.
        const factory = vi.fn<() => Provider>(() => makeProvider({ "dark-mode": true }));
        const definitionEmptyEnv = defineFlags({ provider: factory });

        await createFlags(definitionEmptyEnv, {}).boolean("dark-mode", false);
        await createFlags(definitionEmptyEnv, {}).boolean("dark-mode", false);

        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("rebinds after resetFlags clears the cache", async () => {
        expect.assertions(1);

        const factory = vi.fn<() => Provider>(() => makeProvider({ "dark-mode": true }));
        const definitionReset = defineFlags({ provider: factory });

        await createFlags(definitionReset, env).boolean("dark-mode", false);
        await resetFlags();
        await createFlags(definitionReset, env).boolean("dark-mode", false);

        expect(factory).toHaveBeenCalledTimes(2);
    });
});
