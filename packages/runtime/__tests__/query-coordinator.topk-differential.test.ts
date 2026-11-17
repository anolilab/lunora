import { describe, expect, it } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * Differential proof for the bounded `topK` merge. `referenceTopK` is the
 * original implementation (flatten, stable full sort, slice) kept verbatim as
 * the oracle. The coordinator's output must deep-equal it for every generated
 * input, including heavy score ties and every k class.
 */

type Direction = "asc" | "desc";

interface ScoredRow {
    row: Record<string, unknown>;
    score: number;
}

const compareAsc = (a: number | string, b: number | string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const referenceTopK = (shardValues: ReadonlyArray<unknown>, by: string, direction: Direction, k: number): ReadonlyArray<Record<string, unknown>> => {
    const collected: ScoredRow[] = [];

    for (const v of shardValues) {
        if (!Array.isArray(v)) {
            continue;
        }

        for (const row of v) {
            if (row === null || typeof row !== "object") {
                continue;
            }

            const raw = (row as Record<string, unknown>)[by];
            const score = typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;

            collected.push({ row: row as Record<string, unknown>, score });
        }
    }

    collected.sort((a, b) => (direction === "asc" ? compareAsc(a.score, b.score) : compareAsc(b.score, a.score)));

    return collected.slice(0, k).map((entry) => entry.row);
};

/** Park-Miller minimal standard PRNG: a seeded generator, so every run builds the same cases. */
const createRandom = (seed: number): (() => number) => {
    let state = seed;

    return () => {
        state = (state * 48_271) % 2_147_483_647;

        return state / 2_147_483_647;
    };
};

const pick = <T>(random: () => number, items: ReadonlyArray<T>): T => {
    const item = items[Math.floor(random() * items.length)];

    if (item === undefined) {
        throw new Error("pick: empty candidate list");
    }

    return item;
};

const randomInt = (random: () => number, max: number): number => Math.floor(random() * (max + 1));

/** A score drawn from a small pool so ties are common, plus values that map to -Infinity. */
const randomScore = (random: () => number): unknown => {
    const roll = random();

    if (roll < 0.1) {
        return null;
    }

    if (roll < 0.15) {
        return "not-a-number";
    }

    if (roll < 0.2) {
        return undefined;
    }

    return randomInt(random, 4) / 2;
};

/** A shard payload mixing well-formed rows with the shapes the merge must skip. */
const randomShardPayload = (random: () => number, shardKey: string): unknown => {
    const shape = random();

    if (shape < 0.05) {
        return null;
    }

    if (shape < 0.1) {
        return { notRows: true };
    }

    const rowCount = randomInt(random, 10);
    const rows: unknown[] = [];

    for (let index = 0; index < rowCount; index += 1) {
        const roll = random();

        if (roll < 0.05) {
            rows.push(null);
            continue;
        }

        if (roll < 0.1) {
            rows.push(7);
            continue;
        }

        const row: Record<string, unknown> = { id: `${shardKey}-${String(index)}` };
        const score = randomScore(random);

        if (score !== undefined) {
            row.score = score;
        }

        rows.push(row);
    }

    return rows;
};

/** Every k class the spec names, plus the non-integer and negative inputs the coordinator tolerates. */
const kCandidates = (random: () => number, total: number): number[] => [
    0,
    1,
    Math.max(0, total - 1),
    total,
    total + 1 + randomInt(random, 3),
    randomInt(random, total + 2),
    -1,
    1.5,
    Number.NaN,
];

const createSpyNamespace = (payloads: Map<string, unknown>): ShardNamespaceLike => {
    const stubFor = (shardKey: string) => {
        return {
            fetch: async (): Promise<Response> => Response.json(payloads.get(shardKey) ?? [], { headers: { "content-type": "application/json" } }),
        };
    };

    return {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

describe("topK merge: bounded selection matches the full-sort reference", () => {
    it("returns identical rows, in identical order, for seeded random inputs", async () => {
        expect.hasAssertions();

        const random = createRandom(0x5e_ed_c0_de);
        const cases = 400;

        for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
            const shardCount = randomInt(random, 5);
            const shardKeys = Array.from({ length: shardCount }, (_, index) => `shard-${String(index)}`);
            const payloads = new Map<string, unknown>(shardKeys.map((key) => [key, randomShardPayload(random, key)]));
            const values = shardKeys.map((key) => payloads.get(key));
            const total = values.reduce<number>(
                (sum, value) => sum + (Array.isArray(value) ? value.filter((row) => typeof row === "object" && row !== null).length : 0),
                0,
            );
            const direction: Direction = random() < 0.5 ? "desc" : "asc";
            const k = pick(random, kCandidates(random, total));

            const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: shardKeys }) });
            // eslint-disable-next-line no-await-in-loop -- cases are independent; sequential runs keep the failing case index readable
            const result = await coordinator.fanOut<ReadonlyArray<Record<string, unknown>>>(createSpyNamespace(payloads), {
                args: {},
                fanOut: { merge: { by: "score", direction, k, kind: "topK" }, table: "messages" },
                functionPath: "messages:list",
            });

            expect(result.data, `case ${String(caseIndex)} direction=${direction} k=${String(k)} total=${String(total)}`).toStrictEqual(
                referenceTopK(values, "score", direction, k),
            );
        }
    });

    it("keeps collection order for ties that span shards", async () => {
        expect.assertions(2);

        const payloads = new Map<string, unknown>([
            [
                "a",
                [
                    { id: "a1", score: 1 },
                    { id: "a2", score: 1 },
                ],
            ],
            [
                "b",
                [
                    { id: "b1", score: 1 },
                    { id: "b2", score: 2 },
                ],
            ],
            ["c", [{ id: "c1", score: 1 }]],
        ]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["a", "b", "c"] }) });
        const run = (k: number) =>
            coordinator.fanOut<ReadonlyArray<Record<string, unknown>>>(createSpyNamespace(payloads), {
                args: {},
                fanOut: { merge: { by: "score", k, kind: "topK" }, table: "messages" },
                functionPath: "messages:list",
            });

        const top3 = await run(3);
        const top4 = await run(4);

        expect(top3.data.map((row) => row.id)).toStrictEqual(["b2", "a1", "a2"]);
        expect(top4.data.map((row) => row.id)).toStrictEqual(["b2", "a1", "a2", "b1"]);
    });
});
