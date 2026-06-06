import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CronScheduleKind } from "../src/cron-compile.js";
import { compileCronSchedule } from "../src/cron-compile.js";

interface ParityCase {
    expected: string;
    kind: string;
    schedule: Record<string, unknown>;
}

// The single source of truth lives next to the canonical compiler in
// @cirrus/scheduler. codegen's static mirror (src/cron-compile.ts) is asserted
// against the SAME file so the two compilers cannot silently diverge — a drift
// in either copy fails its parity test against this shared matrix.
const parityCases: ParityCase[] = (
    JSON.parse(readFileSync(new URL("../../scheduler/__tests__/cron-parity.json", import.meta.url), "utf8")) as { cases: ParityCase[] }
).cases;

describe("cron-compile-parity (codegen mirror)", () => {
    it.each(parityCases)("compiles $kind $schedule to $expected", ({ expected, kind, schedule }) => {
        expect.assertions(1);

        expect(compileCronSchedule(kind as CronScheduleKind, schedule)).toBe(expected);
    });
});
