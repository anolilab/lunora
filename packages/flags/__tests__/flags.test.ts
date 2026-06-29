import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from "@openfeature/server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(async () => {
    await resetFlags();
    vi.restoreAllMocks();
});

describe("createFlags", () => {
    it("resolves each flag type through the provider", async () => {
        const provider = makeProvider({
            "max-uploads": 25,
            "ui-config": { theme: "dark" },
            welcome: "hi",
            "dark-mode": true,
        });
        const flags = createFlags({ provider: () => provider });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
        await expect(flags.string("welcome", "fallback")).resolves.toBe("hi");
        await expect(flags.number("max-uploads", 5)).resolves.toBe(25);
        await expect(flags.object("ui-config", { theme: "light" })).resolves.toEqual({ theme: "dark" });
    });

    it("returns the default value for an unknown flag", async () => {
        const provider = makeProvider({});
        const flags = createFlags({ provider: () => provider });

        await expect(flags.boolean("missing", false)).resolves.toBe(false);
        await expect(flags.string("missing", "default")).resolves.toBe("default");
    });

    it("exposes full evaluation details via details.*", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider });

        const details = await flags.details.boolean("dark-mode", false);

        expect(details.value).toBe(true);
        expect(details.reason).toBe("TARGETING_MATCH");
        expect(details.variant).toBe("on");
        expect(details.flagKey).toBe("dark-mode");
    });

    it("merges the default targetingKey under per-call context", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider, targetingKey: "user-123" });

        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.contexts[0]).toMatchObject({ plan: "premium", targetingKey: "user-123" });
    });

    it("lets a per-call targetingKey override the default", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider, targetingKey: "user-123" });

        await flags.boolean("dark-mode", false, { targetingKey: "user-999" });

        expect(provider.contexts[0]?.targetingKey).toBe("user-999");
    });

    it("resolves a targetingKey thunk (codegen passes one wrapping identify)", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider, targetingKey: () => "user-123" });

        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.contexts[0]).toMatchObject({ plan: "premium", targetingKey: "user-123" });
    });

    it("fails open to no targetingKey when the thunk throws (a buggy identify)", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({
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
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider });

        await Promise.all([flags.boolean("dark-mode", false), flags.boolean("dark-mode", false), flags.boolean("dark-mode", false)]);

        expect(provider.counts["dark-mode"]).toBe(1);
    });

    it("does not share memo across different contexts", async () => {
        const provider = makeProvider({ "dark-mode": true });
        const flags = createFlags({ provider: () => provider });

        await flags.boolean("dark-mode", false, { plan: "free" });
        await flags.boolean("dark-mode", false, { plan: "premium" });

        expect(provider.counts["dark-mode"]).toBe(2);
    });

    it("never throws when the provider errors — resolves the default with an errorCode", async () => {
        const provider = makeProvider({ "dark-mode": true }, { resolveThrows: true });
        const flags = createFlags({ provider: () => provider });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(false);

        const details = await flags.details.boolean("dark-mode", false);

        expect(details.value).toBe(false);
        expect(details.reason).toBe("ERROR");
        expect(details.errorCode).toBeDefined();
    });

    it("fails closed to the default when provider construction throws", async () => {
        const flags = createFlags({
            provider: () => {
                throw new Error("no binding");
            },
        });

        await expect(flags.boolean("dark-mode", true)).resolves.toBe(true);
    });

    it("retries the bind on a later request after a failed construction", async () => {
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

        await expect(createFlags({ provider }).boolean("dark-mode", false)).resolves.toBe(false); // first bind fails → default
        await expect(createFlags({ provider }).boolean("dark-mode", false)).resolves.toBe(true); // second request rebinds
        expect(attempts).toBe(2);
    });
});
