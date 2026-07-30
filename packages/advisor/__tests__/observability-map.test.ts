import { describe, expect, it } from "vitest";

import type { AdvisorMap, AdvisorProcedureProtection, Finding, Lint, LintContext } from "../src";
import {
    compareToBaseline,
    coverageFromScore,
    DEFAULT_WEIGHT_BY_LEVEL,
    gradeFromScore,
    MAP_VERSION,
    parseAdvisorMap,
    procedureWeight,
    scoreAdvisor,
    scoreGlobal,
    scoreProcedure,
} from "../src";

/** A procedure as the codegen feeder would supply it; only the scored fields matter here. */
const procedure = (overrides: Partial<AdvisorProcedureProtection> & Pick<AdvisorProcedureProtection, "exportName" | "file">): AdvisorProcedureProtection => {
    return {
        callsMail: false,
        fanOut: false,
        kind: "mutation",
        unboundedAiGeneration: false,
        usesCaptcha: false,
        usesEmailGate: false,
        usesInsertManyUnsafe: false,
        usesMask: false,
        usesRateLimit: false,
        usesRls: false,
        visibility: "public",
        writesUserTable: false,
        ...overrides,
    };
};

/** A finding attributed to `file`/`exportName` when both are supplied. */
const finding = (name: string, level: Finding["level"], metadata: Record<string, unknown> = {}): Finding => {
    return {
        cacheKey: `${name}:${JSON.stringify(metadata)}`,
        categories: ["SECURITY"],
        description: "",
        detail: "",
        facing: "EXTERNAL",
        level,
        metadata,
        name,
        remediation: "",
        title: "",
    };
};

const STAMP = "2026-07-30T00:00:00.000Z";

/** Scoring reads only `procedureProtections`; the schema is present because `LintContext` requires it. */
const contextWith = (procedures: AdvisorProcedureProtection[]): LintContext => {
    return { procedureProtections: procedures, schema: { tables: [] } };
};

describe("scoreProcedure", () => {
    it("starts at 100 and subtracts each check's weight", () => {
        expect.assertions(1);

        expect(
            scoreProcedure([
                { level: "ERROR", name: "a", weight: 20 },
                { level: "WARN", name: "b", weight: 10 },
            ]),
        ).toBe(70);
    });

    it("clamps at zero so one pathological procedure cannot drag the mean negative", () => {
        expect.assertions(1);

        expect(
            scoreProcedure(
                Array.from({ length: 20 }, (_, index) => {
                    return { level: "ERROR" as const, name: `lint_${String(index)}`, weight: 20 };
                }),
            ),
        ).toBe(0);
    });
});

describe("scoreGlobal", () => {
    it("weights entries rather than averaging them flat", () => {
        expect.assertions(1);

        // 100*2 + 0*0.5 = 200 over weight 2.5 → 80, not the flat mean of 50.
        expect(
            scoreGlobal([
                { score: 100, weight: 2 },
                { score: 0, weight: 0.5 },
            ]),
        ).toBe(80);
    });

    it("scores a project with nothing in scope as a vacuous 100", () => {
        expect.assertions(1);

        expect(scoreGlobal([])).toBe(100);
    });
});

describe("procedureWeight", () => {
    it("counts a public handler double and an internal one half", () => {
        expect.assertions(2);

        expect(procedureWeight({ kind: "mutation", visibility: "public" })).toBe(2);
        expect(procedureWeight({ kind: "mutation", visibility: "internal" })).toBe(0.5);
    });

    it("halves a query even when public — kind wins over visibility", () => {
        expect.assertions(1);

        expect(procedureWeight({ kind: "query", visibility: "public" })).toBe(0.5);
    });
});

describe("gradeFromScore / coverageFromScore", () => {
    it("bands scores on evlog's thresholds", () => {
        expect.assertions(4);

        expect(gradeFromScore(90)).toBe("excellent");
        expect(gradeFromScore(70)).toBe("good");
        expect(gradeFromScore(50)).toBe("needs-work");
        expect(gradeFromScore(49)).toBe("at-risk");
    });

    it("calls a clean procedure instrumented and one below the floor dark", () => {
        expect.assertions(3);

        expect(coverageFromScore(100)).toBe("instrumented");
        expect(coverageFromScore(50)).toBe("partial");
        expect(coverageFromScore(49)).toBe("dark");
    });
});

describe("scoreAdvisor", () => {
    it("attributes a finding to its procedure via file + exportName", () => {
        expect.assertions(3);

        const map = scoreAdvisor(
            contextWith([procedure({ exportName: "sendMessage", file: "messages" })]),
            [finding("public_mutation_without_ratelimit", "WARN", { exportName: "sendMessage", file: "messages" })],
            { generatedAt: STAMP },
        );

        expect(map.procedures).toHaveLength(1);
        expect(map.procedures[0]?.score).toBe(100 - DEFAULT_WEIGHT_BY_LEVEL.WARN);
        expect(map.procedures[0]?.checks).toStrictEqual([{ level: "WARN", name: "public_mutation_without_ratelimit", weight: 10 }]);
    });

    it("routes a finding naming no procedure to the project bucket", () => {
        expect.assertions(2);

        const map = scoreAdvisor(contextWith([]), [finding("circular_fk", "ERROR", { table: "invoices" })], { generatedAt: STAMP });

        expect(map.project.checks).toHaveLength(1);
        // The project entry is the only thing in scope, so it *is* the global score.
        expect(map.score).toBe(80);
    });

    it("routes a finding whose file/export the feeder never declared to the project bucket rather than dropping it", () => {
        expect.assertions(2);

        const map = scoreAdvisor(
            contextWith([procedure({ exportName: "known", file: "a" })]),
            [finding("some_lint", "ERROR", { exportName: "ghost", file: "nowhere" })],
            { generatedAt: STAMP },
        );

        expect(map.procedures[0]?.checks).toStrictEqual([]);
        expect(map.project.checks).toHaveLength(1);
    });

    it("lets an explicit lint weight override the severity ladder", () => {
        expect.assertions(1);

        const lint = { name: "heavy_lint", weight: 45 } as Lint;
        const map = scoreAdvisor(contextWith([procedure({ exportName: "a", file: "f" })]), [finding("heavy_lint", "INFO", { exportName: "a", file: "f" })], {
            generatedAt: STAMP,
            lints: [lint],
        });

        expect(map.procedures[0]?.score).toBe(55);
    });

    it("marks exempt procedures and drops them from the weighted mean", () => {
        expect.assertions(3);

        const map = scoreAdvisor(
            contextWith([procedure({ exportName: "legacy", file: "old" }), procedure({ exportName: "fine", file: "new" })]),
            [finding("bad_lint", "ERROR", { exportName: "legacy", file: "old" })],
            { exempt: ["old#legacy"], generatedAt: STAMP },
        );

        const legacy = map.procedures.find((entry) => entry.id === "old#legacy");

        expect(legacy?.coverage).toBe("exempt");
        expect(legacy?.weight).toBe(0);
        // Only the clean procedure and the clean project entry count.
        expect(map.score).toBe(100);
    });

    it("produces a deterministic, stably-sorted map for a committed baseline", () => {
        expect.assertions(2);

        const build = (): AdvisorMap =>
            scoreAdvisor(
                contextWith([procedure({ exportName: "b", file: "z" }), procedure({ exportName: "a", file: "a" })]),
                [finding("l2", "WARN", { exportName: "b", file: "z" }), finding("l1", "INFO", { exportName: "b", file: "z" })],
                { generatedAt: STAMP },
            );

        const map = build();

        expect(map.procedures.map((entry) => entry.id)).toStrictEqual(["a#a", "z#b"]);
        expect(JSON.stringify(build())).toStrictEqual(JSON.stringify(map));
    });

    it("summarises coverage across the map", () => {
        expect.assertions(1);

        const map = scoreAdvisor(
            contextWith([procedure({ exportName: "clean", file: "a" }), procedure({ exportName: "broken", file: "b" })]),
            [
                finding("e1", "ERROR", { exportName: "broken", file: "b" }),
                finding("e2", "ERROR", { exportName: "broken", file: "b" }),
                finding("e3", "ERROR", { exportName: "broken", file: "b" }),
            ],
            { generatedAt: STAMP },
        );

        expect(map.summary).toStrictEqual({ dark: 1, exempt: 0, findings: 3, instrumented: 1, partial: 0, procedures: 2 });
    });
});

describe("compareToBaseline", () => {
    const baselineOf = (findings: Finding[], procedures: AdvisorProcedureProtection[]): AdvisorMap =>
        scoreAdvisor(contextWith(procedures), findings, { generatedAt: STAMP });

    const procedures = [procedure({ exportName: "a", file: "f" }), procedure({ exportName: "b", file: "f" })];

    it("reports no regression when nothing moved", () => {
        expect.assertions(2);

        const map = baselineOf([], procedures);
        const comparison = compareToBaseline(map, map);

        expect(comparison.regressed).toBe(false);
        expect(comparison.scoreDelta).toBe(0);
    });

    it("flags a procedure that got worse even when it is still above the dark floor", () => {
        expect.assertions(3);

        const before = baselineOf([], procedures);
        const after = baselineOf([finding("l", "WARN", { exportName: "a", file: "f" })], procedures);
        const comparison = compareToBaseline(after, before);

        expect(comparison.regressed).toBe(true);
        expect(comparison.dropped).toStrictEqual([{ after: 90, before: 100, id: "f#a" }]);
        expect(comparison.newDark).toStrictEqual([]);
    });

    it("flags a brand-new dark procedure that has no baseline row", () => {
        expect.assertions(2);

        const before = baselineOf([], [procedure({ exportName: "a", file: "f" })]);
        const after = baselineOf(
            [
                finding("x", "ERROR", { exportName: "b", file: "f" }),
                finding("y", "ERROR", { exportName: "b", file: "f" }),
                finding("z", "ERROR", { exportName: "b", file: "f" }),
            ],
            procedures,
        );
        const comparison = compareToBaseline(after, before);

        expect(comparison.newDark).toStrictEqual(["f#b"]);
        expect(comparison.regressed).toBe(true);
    });

    it("refuses to compare across artifact versions instead of mis-reading the baseline", () => {
        expect.assertions(2);

        const map = baselineOf([], procedures);
        const comparison = compareToBaseline(map, { ...map, version: MAP_VERSION + 1 });

        expect(comparison.comparable).toBe(false);
        expect(comparison.regressed).toBe(false);
    });
});

describe("parseAdvisorMap", () => {
    it("accepts a map this build wrote and rejects anything else", () => {
        expect.assertions(4);

        const map = scoreAdvisor(contextWith([]), [], { generatedAt: STAMP });

        // Round-trip through JSON rather than structuredClone: this is exactly what
        // reading a committed `lunora.advisor.map.json` off disk does.
        const onDisk = JSON.stringify(map);

        expect(parseAdvisorMap(JSON.parse(onDisk))).toStrictEqual(map);
        expect(parseAdvisorMap({ ...map, version: MAP_VERSION + 1 })).toBeUndefined();
        expect(parseAdvisorMap(null)).toBeUndefined();
        expect(parseAdvisorMap("nope")).toBeUndefined();
    });
});
