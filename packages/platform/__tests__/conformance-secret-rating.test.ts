import { describe, expect, it } from "vitest";

import { CLOUDFLARE_CAPABILITIES, NODE_CAPABILITIES } from "../src";
import type { ConformanceHost, ConformanceHostFactory } from "../src/conformance";
import { createReferenceHost, defineHostContractSuite } from "../src/conformance";

/**
 * The secret-value legs must agree with the capability matrix in both
 * directions, and a disagreement has to fail rather than skip. These run the
 * real suite against deliberately mis-configured hosts: the suite's `describe`
 * and `it` are replaced by a collector, its `expect` by one that throws on
 * mismatch, and `context.skip` by a sentinel, so each leg's outcome is visible
 * without a vitest runner.
 */

type LegOutcome = "failed" | "passed" | "skipped";

type Leg = {
    body: (context: { skip: (reason?: string) => never }) => Promise<void> | void;
    name: string;
};

class SkipSignal extends Error {}

const matchers = (actual: unknown, negated: boolean) => {
    return {
        toBe: (expected: unknown) => {
            if (Object.is(actual, expected) === negated) {
                throw new Error(`expected ${String(actual)} ${negated ? "not " : ""}to be ${String(expected)}`);
            }
        },
        toBeUndefined: () => {
            if ((actual === undefined) === negated) {
                throw new Error(`expected ${negated ? "a value" : "undefined"}, got ${String(actual)}`);
            }
        },
    };
};

// `assertions` and `hasAssertions` are no-ops: a count belongs to a real vitest
// run, and this harness only needs to know whether a leg throws.
const recordingExpect = Object.assign(
    (actual: unknown) => {
        return { ...matchers(actual, false), not: matchers(actual, true) };
    },
    {
        assertions: () => undefined,
        hasAssertions: () => undefined,
    },
);

const collectLegs = (factory: ConformanceHostFactory): Leg[] => {
    const legs: Leg[] = [];
    const path: string[] = [];

    const describeCollector = (name: string, register: () => void): void => {
        path.push(name);

        try {
            register();
        } finally {
            path.pop();
        }
    };

    const itCollector = (name: string, body: Leg["body"]): void => {
        legs.push({ body, name: [...path, name].join(" > ") });
    };

    defineHostContractSuite("fake", factory, { describe: describeCollector, expect: recordingExpect, it: itCollector } as never);

    return legs;
};

const outcome = async (leg: Leg): Promise<LegOutcome> => {
    try {
        await leg.body({
            skip: (reason) => {
                throw new SkipSignal(reason);
            },
        });

        return "passed";
    } catch (error) {
        return error instanceof SkipSignal ? "skipped" : "failed";
    }
};

/** Outcome of every `SecretValueHost` leg, against a reference host overridden by `overrides`. */
const secretOutcomes = async (overrides: Partial<ConformanceHost>): Promise<Map<string, LegOutcome>> => {
    const legs = collectLegs(async () => {
        return { ...createReferenceHost(), ...overrides };
    }).filter((leg) => leg.name.includes("SecretValueHost"));
    const entries = await Promise.all(legs.map(async (leg) => [leg.name, await outcome(leg)] as const));

    return new Map(entries);
};

const PRESENCE = "matches the capability matrix's rating for secretValues";

const presenceOutcome = (results: Map<string, LegOutcome>): LegOutcome | undefined => [...results].find(([name]) => name.includes(PRESENCE))?.[1];

const absentSurfaces: Partial<ConformanceHost> = { advanceClock: undefined, secretValueStore: undefined, secretValues: undefined };

describe("secret-value legs against the capability matrix", () => {
    it("fails a host rated supported that omits the secret surfaces, and skips none of its legs", async () => {
        expect.assertions(2);

        const results = await secretOutcomes({ ...absentSurfaces, capabilities: CLOUDFLARE_CAPABILITIES });

        expect(presenceOutcome(results)).toBe("failed");
        expect([...results.values()]).not.toContain("skipped");
    });

    it("fails a host rated unsupported that still offers the secret surfaces", async () => {
        expect.assertions(1);

        const results = await secretOutcomes({ capabilities: NODE_CAPABILITIES });

        expect(presenceOutcome(results)).toBe("failed");
    });

    it("passes a host rated unsupported that omits them, with no leg skipped", async () => {
        expect.assertions(1);

        const results = await secretOutcomes({ ...absentSurfaces, capabilities: NODE_CAPABILITIES });

        expect(new Set(results.values())).toStrictEqual(new Set<LegOutcome>(["passed"]));
    });

    it("fails a host with no matrix that omits them, since it must provide every optional surface", async () => {
        expect.assertions(1);

        const results = await secretOutcomes({ ...absentSurfaces, capabilities: undefined });

        expect(presenceOutcome(results)).toBe("failed");
    });

    it("fails a host whose matrix leaves secretValues undeclared", async () => {
        expect.assertions(1);

        const undeclared = { ...CLOUDFLARE_CAPABILITIES, features: { ...CLOUDFLARE_CAPABILITIES.features, secretValues: undefined } };
        const results = await secretOutcomes({ capabilities: undeclared });

        expect(presenceOutcome(results)).toBe("failed");
    });
});
