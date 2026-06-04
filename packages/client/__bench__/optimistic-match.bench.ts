import { bench, describe } from "vitest";

/**
 * `applyOptimisticUpdates` fans out across every active subscription on every
 * optimistic mutation. The original implementation re-serialized each
 * subscription's `args` with `stableStringify` inside that loop, even though
 * `args` is fixed at subscribe time. The fix caches `argsKey` on the
 * subscription state once and compares strings directly.
 *
 * This bench contrasts the two match strategies against a realistic fan-out
 * (200 active subscriptions, a moderately-nested args record) so the win is
 * demonstrable. Pure-Node, no workerd.
 */

const compareEntryKeys = ([a]: [string, unknown], [b]: [string, unknown]): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).toSorted(compareEntryKeys);

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

interface SubState {
    args: Record<string, unknown>;
    argsKey: string;
    shardKey: string | undefined;
}

const SUBSCRIPTION_COUNT = 200;

const makeArgs = (index: number): Record<string, unknown> => {
    return {
        channel: { id: `channel_${index.toString()}`, kind: "room" },
        cursor: index * 25,
        filters: { archived: false, limit: 50, tags: ["a", "b", "c"] },
        userId: `user_${index.toString()}`,
    };
};

const subscriptions: SubState[] = Array.from({ length: SUBSCRIPTION_COUNT }, (_v, index) => {
    const args = makeArgs(index);

    return { args, argsKey: stableStringify(args), shardKey: index % 2 === 0 ? "even" : "odd" };
});

// A mutation that matches exactly one subscription (the common case): the loop
// still has to test every subscription's args against the mutation's args.
const mutationArgs = makeArgs(123);
const mutationArgsKey = stableStringify(mutationArgs);
const mutationShardKey = "odd";

describe("applyOptimisticUpdates args matching", () => {
    // Old: re-stringify each subscription's args inside the loop.
    bench("re-stringify per subscription (old)", () => {
        let matches = 0;

        for (const state of subscriptions) {
            if (state.shardKey !== mutationShardKey || stableStringify(state.args) !== mutationArgsKey) {
                continue;
            }

            matches += 1;
        }

        if (matches < 0) {
            throw new Error("unreachable");
        }
    });

    // New: compare the cached argsKey directly.
    bench("compare cached argsKey (new)", () => {
        let matches = 0;

        for (const state of subscriptions) {
            if (state.shardKey !== mutationShardKey || state.argsKey !== mutationArgsKey) {
                continue;
            }

            matches += 1;
        }

        if (matches < 0) {
            throw new Error("unreachable");
        }
    });
});
