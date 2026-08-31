import { describe, expect, it } from "vitest";

import { ROLLOUT_BUCKETS, rolloutBucket, rolloutKey, servesCandidate } from "../src/dispatcher/rollout";

describe(rolloutBucket, () => {
    it("lands every key inside the bucket range", () => {
        for (let index = 0; index < 500; index += 1) {
            const bucket = rolloutBucket(`10.0.0.${String(index)}:acme`);

            expect(bucket).toBeGreaterThanOrEqual(0);
            expect(bucket).toBeLessThan(ROLLOUT_BUCKETS);
        }
    });

    it("is deterministic — the same client keeps the same version", () => {
        expect(rolloutBucket("203.0.113.7:acme")).toBe(rolloutBucket("203.0.113.7:acme"));
    });

    /**
     * A hash that clumps would make a 10% rollout serve 40% of traffic, or none.
     * Not a uniformity proof — just enough spread that the percentage means
     * roughly what it says.
     */
    it("spreads keys across the range rather than clumping", () => {
        const seen = new Set<number>();

        for (let index = 0; index < 300; index += 1) {
            seen.add(rolloutBucket(`198.51.100.${String(index)}:acme`));
        }

        expect(seen.size).toBeGreaterThan(50);
    });
});

describe(servesCandidate, () => {
    it("serves nobody at 0 and everybody at 100", () => {
        expect(servesCandidate("203.0.113.7:acme", 0)).toBe(false);
        expect(servesCandidate("203.0.113.7:acme", 100)).toBe(true);
    });

    /**
     * The property that makes advancing a rollout safe. Raising the percentage
     * only ADDS buckets — a client already on the candidate is never moved back,
     * so progressing cannot itself look like a regression.
     */
    it("never moves a client off the candidate as the percentage rises", () => {
        const keys = Array.from({ length: 200 }, (_, index) => `10.1.0.${String(index)}:acme`);
        let previous = new Set(keys.filter((key) => servesCandidate(key, 5)));

        for (const percent of [10, 25, 50, 75, 100]) {
            const current = new Set(keys.filter((key) => servesCandidate(key, percent)));

            for (const key of previous) {
                expect(current.has(key)).toBe(true);
            }

            previous = current;
        }
    });

    it("serves roughly the requested share", () => {
        const keys = Array.from({ length: 1000 }, (_, index) => `172.16.${String(Math.floor(index / 256))}.${String(index % 256)}:acme`);
        const served = keys.filter((key) => servesCandidate(key, 25)).length;

        // Wide bounds on purpose: this asserts the split is in the right
        // neighbourhood, not that a 32-bit hash is perfectly uniform.
        expect(served).toBeGreaterThan(150);
        expect(served).toBeLessThan(350);
    });

    it("treats a nonsense percentage as off rather than throwing", () => {
        expect(servesCandidate("k", Number.NaN)).toBe(false);
        expect(servesCandidate("k", -10)).toBe(false);
    });
});

describe(rolloutKey, () => {
    /**
     * Scoping by alias is what stops one unlucky address sitting in the candidate
     * group for every rollout on the platform at once — a caller who saw one bad
     * canary would otherwise see all of them.
     */
    it("puts one client in different buckets for different projects", () => {
        const buckets = new Set(["acme", "globex", "initech", "umbrella"].map((alias) => rolloutBucket(rolloutKey("203.0.113.7", alias))));

        expect(buckets.size).toBeGreaterThan(1);
    });

    it("gives an unidentifiable caller a stable bucket rather than a random one", () => {
        expect(rolloutKey(null, "acme")).toBe(rolloutKey(null, "acme"));
        expect(rolloutKey(null, "acme")).toContain("unknown");
    });
});
