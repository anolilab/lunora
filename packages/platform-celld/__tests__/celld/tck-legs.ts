/**
 * The two conformance suites as flat, indexable legs.
 *
 * celld has no vitest pool, so the suites cannot register against a runner
 * that lives inside the cell. Instead both sides of the run call
 * {@link collectLegs}: the node-side vitest file to learn every leg's name (one
 * `it` per leg), and the worker inside celld to find the body for the index it
 * was asked to run. The suites are pure registration, so both sides see the
 * same legs in the same order.
 */
import type { ConformanceHostFactory } from "@lunora/platform/conformance";
import { defineHostContractSuite } from "@lunora/platform/conformance/suite";
import type { EngineHostFactory } from "@lunora/shard-engine/conformance";
import { defineEngineContractSuite } from "@lunora/shard-engine/conformance";

/** What a leg's body receives in place of vitest's `TestContext`. */
type LegContext = { skip: (reason?: string) => never };

type Leg = { body: (context: LegContext) => Promise<void> | void; name: string };

type SuiteName = "engine" | "platform";

/** What `/leg` answers — shared by the worker that runs a leg and the test that reads it. */
type LegResult = { message?: string; status: "failed" | "passed" | "skipped" };

type Factories = { engine: EngineHostFactory; platform: ConformanceHostFactory };

/** Thrown by `context.skip()`; the runner reports the leg as skipped, not failed. */
class LegSkipped extends Error {
    public constructor(reason?: string) {
        super(reason ?? "skipped");
        this.name = "LegSkipped";
    }
}

/**
 * Register one suite against a collecting `describe`/`it` pair and return its
 * legs. `expect` is whatever the caller runs with — the node side never
 * executes a body, so it passes a placeholder.
 * @param suite Which suite to collect.
 * @param factories The host factories the suite bodies will call.
 * @param expect The `expect` the bodies assert with.
 * @returns every leg, in registration order.
 */
const collectLegs = (suite: SuiteName, factories: Factories, expect: unknown): Leg[] => {
    const legs: Leg[] = [];
    const path: string[] = [];

    const describe = (name: string, register: () => void): void => {
        path.push(name);

        try {
            register();
        } finally {
            path.pop();
        }
    };

    const it = (name: string, body: Leg["body"]): void => {
        legs.push({ body, name: [...path, name].join(" > ") });
    };

    const vitest = { describe, expect, it } as never;

    if (suite === "platform") {
        defineHostContractSuite("celld", factories.platform, vitest);
    } else {
        defineEngineContractSuite("celld", factories.engine, vitest);
    }

    return legs;
};

export type { Factories, Leg, LegContext, LegResult, SuiteName };
export { collectLegs, LegSkipped };
