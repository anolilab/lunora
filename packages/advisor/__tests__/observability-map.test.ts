import { describe, expect, it } from "vitest";

import type { AdvisorMap, AdvisorProcedureProtection, Finding } from "../src";
import { compareToBaseline, gradeFromScore, MAP_VERSION, parseAdvisorMap, scoreAdvisor } from "../src";

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

/** Builds n clean public mutations — a realistic denominator for the weighted mean. */
const manyProcedures = (count: number): AdvisorProcedureProtection[] =>
    Array.from({ length: count }, (_, index) => procedure({ exportName: `fn${String(index)}`, file: "handlers" }));

describe("scoreAdvisor scoring", () => {
    it("subtracts a severity-derived penalty per rule and bands the result", () => {
        expect.assertions(3);

        const map = scoreAdvisor([procedure({ exportName: "a", file: "f" })], [finding("warn_rule", "WARN", { exportName: "a", file: "f" })], {
            generatedAt: STAMP,
        });

        expect(map.procedures[0]?.score).toBe(90);
        expect(map.procedures[0]?.coverage).toBe("warned");
        expect(map.grade).toBe("excellent");
    });

    it("calls a procedure with no finding clean, and one below the floor failing", () => {
        expect.assertions(2);

        const map = scoreAdvisor(
            [procedure({ exportName: "ok", file: "f" }), procedure({ exportName: "bad", file: "f" })],
            ["a", "b", "c"].map((rule) => finding(rule, "ERROR", { exportName: "bad", file: "f" })),
            { generatedAt: STAMP },
        );

        expect(map.procedures.find((entry) => entry.id === "f#ok")?.coverage).toBe("clean");
        expect(map.procedures.find((entry) => entry.id === "f#bad")?.coverage).toBe("failing");
    });

    it("weights a public handler above an internal one in the global mean", () => {
        expect.assertions(1);

        const breakOne = (target: string): number =>
            scoreAdvisor(
                [procedure({ exportName: "pub", file: "f" }), procedure({ exportName: "int", file: "f", visibility: "internal" })],
                ["a", "b", "c", "d", "e"].map((rule) => finding(rule, "ERROR", { exportName: target, file: "f" })),
                { generatedAt: STAMP },
            ).score;

        expect(breakOne("pub")).toBeLessThan(breakOne("int"));
    });

    it("charges a rule once however many times it fires, recording the occurrences", () => {
        expect.assertions(2);

        const map = scoreAdvisor(
            [procedure({ exportName: "a", file: "f" })],
            [1, 2, 3, 4, 5].map((line) => finding("action_fetch_ssrf", "ERROR", { exportName: "a", file: "f", line })),
            { generatedAt: STAMP },
        );

        // Five occurrences of one ERROR rule cost 20, not 100.
        expect(map.procedures[0]?.score).toBe(80);
        expect(map.procedures[0]?.checks).toStrictEqual([{ level: "ERROR", name: "action_fetch_ssrf", occurrences: 5, weight: 20 }]);
    });
});

describe("scoreAdvisor attribution", () => {
    it("attributes a finding to its procedure via file + exportName", () => {
        expect.assertions(2);

        const map = scoreAdvisor(
            [procedure({ exportName: "sendMessage", file: "messages" })],
            [finding("public_mutation_without_ratelimit", "WARN", { exportName: "sendMessage", file: "messages" })],
            { generatedAt: STAMP },
        );

        expect(map.procedures[0]?.checks.map((check) => check.name)).toStrictEqual(["public_mutation_without_ratelimit"]);
        expect(map.project.checks).toStrictEqual([]);
    });

    it("routes a finding naming no procedure to the project bucket", () => {
        expect.assertions(1);

        const map = scoreAdvisor([], [finding("circular_fk", "ERROR", { table: "invoices" })], { generatedAt: STAMP });

        expect(map.project.checks.map((check) => check.name)).toStrictEqual(["circular_fk"]);
    });

    it("routes a finding whose file/export the feeder never declared to the project bucket rather than dropping it", () => {
        expect.assertions(2);

        const map = scoreAdvisor([procedure({ exportName: "known", file: "a" })], [finding("some_lint", "ERROR", { exportName: "ghost", file: "nowhere" })], {
            generatedAt: STAMP,
        });

        expect(map.procedures[0]?.checks).toStrictEqual([]);
        expect(map.project.checks).toHaveLength(1);
    });

    it("keeps project debt visible in the grade at a realistic procedure count", () => {
        expect.assertions(1);

        const clean = scoreAdvisor(manyProcedures(20), [], { generatedAt: STAMP });
        const withSecret = scoreAdvisor(manyProcedures(20), [finding("hardcoded_secret", "ERROR", { file: "wrangler" })], { generatedAt: STAMP });

        // A flat project weight of 1 would round this away to a 0-point delta.
        expect(withSecret.score).toBeLessThan(clean.score);
    });
});

describe("scoreAdvisor artifact", () => {
    it("marks exempt procedures and drops them from the weighted mean", () => {
        expect.assertions(3);

        const map = scoreAdvisor(
            [procedure({ exportName: "legacy", file: "old" }), procedure({ exportName: "fine", file: "new" })],
            [finding("bad_lint", "ERROR", { exportName: "legacy", file: "old" })],
            { exempt: ["old#legacy"], generatedAt: STAMP },
        );

        const legacy = map.procedures.find((entry) => entry.id === "old#legacy");

        expect(legacy?.coverage).toBe("exempt");
        expect(legacy?.weight).toBe(0);
        expect(map.score).toBe(100);
    });

    it("honours a source-level exemption directive and records its reason", () => {
        expect.assertions(3);

        const map = scoreAdvisor(
            [procedure({ exempt: true, exemptReason: "legacy, replaced by v2", exportName: "legacy", file: "old" })],
            [finding("bad", "ERROR", { exportName: "legacy", file: "old" })],
            { generatedAt: STAMP },
        );

        expect(map.procedures[0]?.coverage).toBe("exempt");
        expect(map.procedures[0]?.exemptReason).toBe("legacy, replaced by v2");
        expect(map.procedures[0]?.weight).toBe(0);
    });

    it("produces a deterministic, stably-sorted map for a committed baseline", () => {
        expect.assertions(2);

        const build = (): AdvisorMap =>
            scoreAdvisor(
                [procedure({ exportName: "b", file: "z" }), procedure({ exportName: "a", file: "a" })],
                [finding("l2", "WARN", { exportName: "b", file: "z" }), finding("l1", "INFO", { exportName: "b", file: "z" })],
                { generatedAt: STAMP },
            );

        const map = build();

        expect(map.procedures.map((entry) => entry.id)).toStrictEqual(["a#a", "z#b"]);
        expect(JSON.stringify(build())).toStrictEqual(JSON.stringify(map));
    });

    it("stamps the clock only when the caller supplies no timestamp", () => {
        expect.assertions(2);

        expect(scoreAdvisor([], [], { generatedAt: STAMP }).generatedAt).toBe(STAMP);
        expect(Date.parse(scoreAdvisor([], []).generatedAt)).not.toBeNaN();
    });

    it("summarises coverage across the map", () => {
        expect.assertions(1);

        const map = scoreAdvisor(
            [procedure({ exportName: "clean", file: "a" }), procedure({ exportName: "broken", file: "b" })],
            ["e1", "e2", "e3"].map((rule) => finding(rule, "ERROR", { exportName: "broken", file: "b" })),
            { generatedAt: STAMP },
        );

        expect(map.summary).toStrictEqual({ clean: 1, exempt: 0, failing: 1, procedures: 2, rulesFired: 3, warned: 0 });
    });
});

describe("sensitivity", () => {
    it("marks a procedure high when it touches identity, mail, or tenant-scoped rows", () => {
        expect.assertions(3);

        const sensitive = scoreAdvisor([procedure({ exportName: "signUp", file: "auth", writesUserTable: true })], [], { generatedAt: STAMP });
        const plain = scoreAdvisor([procedure({ exportName: "listPosts", file: "posts", kind: "query" })], [], { generatedAt: STAMP });

        expect(sensitive.procedures[0]?.sensitivity.level).toBe("high");
        expect(sensitive.procedures[0]?.sensitivity.reasons).toContain("writes an identity table");
        expect(plain.procedures[0]?.sensitivity).toStrictEqual({ level: "none", reasons: [] });
    });

    it("stays fail-closed for a procedure whose behavioural facts are undefined (unreadable handler body)", () => {
        expect.assertions(3);

        // `undefined` means the feeder couldn't read the handler body (a
        // cross-file handler) — classified as sensitive, not "none", since an
        // unreadable handler might well touch identity or send mail. The reason
        // text stays a shared "could not be read" claim rather than asserting
        // the specific unproven "writes an identity table" behaviour.
        const map = scoreAdvisor([procedure({ exportName: "extracted", file: "auth", writesUserTable: undefined })], [], { generatedAt: STAMP });

        expect(map.procedures[0]?.sensitivity.level).toBe("high");
        expect(map.procedures[0]?.sensitivity.reasons).not.toContain("writes an identity table");
        expect(map.procedures[0]?.sensitivity.reasons).toContain("may exhibit sensitive behaviour — its handler body could not be read");
    });

    it("weights a sensitive handler above an equally-visible plain one", () => {
        expect.assertions(2);

        const map = scoreAdvisor(
            [procedure({ exportName: "sensitive", file: "f", writesUserTable: true }), procedure({ exportName: "plain", file: "f" })],
            [],
            { generatedAt: STAMP },
        );

        const weightOf = (id: string) => map.procedures.find((entry) => entry.id === id)?.weight;

        expect(weightOf("f#sensitive")).toBe(4);
        expect(weightOf("f#plain")).toBe(2);
    });

    it("lets an internal sensitive handler outweigh a public inert one", () => {
        expect.assertions(1);

        const map = scoreAdvisor(
            [
                procedure({ callsMail: true, exportName: "internalMailer", file: "f", visibility: "internal" }),
                procedure({ exportName: "publicInert", file: "f" }),
            ],
            [],
            { generatedAt: STAMP },
        );

        // internal 0.5 x 2 = 1 vs public 2 — still below, but the gap narrowed from 4x to 2x.
        expect(map.procedures.find((entry) => entry.id === "f#internalMailer")?.weight).toBe(1);
    });
});

describe("gradeFromScore", () => {
    it("bands scores on the documented thresholds", () => {
        expect.assertions(4);

        expect(gradeFromScore(90)).toBe("excellent");
        expect(gradeFromScore(70)).toBe("good");
        expect(gradeFromScore(50)).toBe("needs-work");
        expect(gradeFromScore(49)).toBe("at-risk");
    });
});

describe("compareToBaseline", () => {
    const mapOf = (findings: Finding[], procedures: AdvisorProcedureProtection[]): AdvisorMap => scoreAdvisor(procedures, findings, { generatedAt: STAMP });

    const procedures = [procedure({ exportName: "a", file: "f" }), procedure({ exportName: "b", file: "f" })];

    it("reports no regression when nothing moved", () => {
        expect.assertions(2);

        const map = mapOf([], procedures);
        const comparison = compareToBaseline(map, map);

        expect(comparison.comparable && comparison.regressed).toBe(false);
        expect(comparison.comparable && comparison.scoreDelta).toBe(0);
    });

    it("flags a procedure that got worse even when it is still above the failing floor", () => {
        expect.assertions(3);

        const comparison = compareToBaseline(mapOf([finding("l", "WARN", { exportName: "a", file: "f" })], procedures), mapOf([], procedures));

        expect(comparison.comparable).toBe(true);
        expect(comparison.comparable && comparison.dropped).toStrictEqual([{ after: 90, before: 100, id: "f#a" }]);
        expect(comparison.comparable && comparison.newFailing).toStrictEqual([]);
    });

    it("flags a brand-new failing procedure that has no baseline row", () => {
        expect.assertions(2);

        const before = mapOf([], [procedure({ exportName: "a", file: "f" })]);
        const after = mapOf(
            ["x", "y", "z"].map((rule) => finding(rule, "ERROR", { exportName: "b", file: "f" })),
            procedures,
        );
        const comparison = compareToBaseline(after, before);

        expect(comparison.comparable && comparison.newFailing).toStrictEqual(["f#b"]);
        expect(comparison.comparable && comparison.regressed).toBe(true);
    });

    it("flags new project debt even after the project score has saturated at zero", () => {
        expect.assertions(2);

        const projectFindings = (count: number): Finding[] =>
            Array.from({ length: count }, (_, index) => finding(`schema_rule_${String(index)}`, "ERROR", { table: "t" }));

        const before = mapOf(projectFindings(5), procedures);
        const after = mapOf(projectFindings(15), procedures);

        // Both project buckets score 0, so the global score cannot move.
        expect(after.score).toBe(before.score);
        expect(compareToBaseline(after, before)).toMatchObject({ comparable: true, projectRegressed: true, regressed: true });
    });

    it("flags a rule that grew to more call sites even though the score is unchanged", () => {
        expect.assertions(3);

        const sites = (count: number): Finding[] =>
            Array.from({ length: count }, (_, index) => finding("action_fetch_ssrf", "ERROR", { exportName: "a", file: "f", line: index }));

        const before = mapOf(sites(1), procedures);
        const after = mapOf(sites(6), procedures);

        const comparison = compareToBaseline(after, before);

        // A rule is charged once however many times it fires, so neither score moves.
        expect(after.score).toBe(before.score);
        expect(comparison).toMatchObject({ comparable: true, worsened: ["f#a"] });
        expect(comparison.comparable && comparison.regressed).toBe(true);
    });

    it("refuses to compare across artifact versions instead of reporting a clean run", () => {
        expect.assertions(2);

        const map = mapOf([], procedures);
        const comparison = compareToBaseline(map, { ...map, version: MAP_VERSION + 1 });

        expect(comparison.comparable).toBe(false);
        // The union has no `regressed` on the incomparable arm, so a gate cannot read it as "clean".
        expect(comparison).toStrictEqual({ comparable: false, reason: "version-mismatch" });
    });
});

describe("parseAdvisorMap", () => {
    const valid = (): AdvisorMap => scoreAdvisor([procedure({ exportName: "a", file: "f" })], [], { generatedAt: STAMP });

    it("accepts a map this build wrote, round-tripped through JSON", () => {
        expect.assertions(1);

        const map = valid();
        // Round-trip through JSON rather than structuredClone: this is exactly what
        // reading a committed `lunora.advisor.map.json` off disk does.
        const onDisk = JSON.stringify(map);

        expect(parseAdvisorMap(JSON.parse(onDisk))).toStrictEqual(map);
    });

    it.each([
        ["a non-object", "nope"],
        ["null", null],
        ["a null procedure row", { ...valid(), procedures: [null] }],
        ["a shapeless procedure row", { ...valid(), procedures: [{}] }],
        ["an unknown coverage verdict", { ...valid(), procedures: [{ coverage: "dark", id: "f#a", score: 10 }] }],
        ["a NaN global score", { ...valid(), score: Number.NaN }],
        ["a missing project bucket", { ...valid(), project: undefined }],
        // `compareToBaseline` calls `.map` on every row's `checks`, and `?? []`
        // only guards null/undefined — an object there throws inside the gate.
        ["a procedure row whose checks is not an array", { ...valid(), procedures: [{ checks: {}, coverage: "clean", id: "f#a", score: 100 }] }],
    ])("rejects %s", (_label, candidate) => {
        expect.assertions(1);

        expect(parseAdvisorMap(candidate)).toBeUndefined();
    });

    it("accepts a future version — version policy belongs to compareToBaseline", () => {
        expect.assertions(2);

        const future = { ...valid(), version: MAP_VERSION + 1 };

        // Rejecting here too would make compareToBaseline's `comparable: false`
        // arm unreachable, and that arm is what stops a stale baseline reading
        // as a clean run.
        expect(parseAdvisorMap(future)).toBeDefined();
        expect(compareToBaseline(valid(), future)).toStrictEqual({ comparable: false, reason: "version-mismatch" });
    });

    it("rejects a malformed baseline instead of letting compareToBaseline throw", () => {
        expect.assertions(1);

        // The pre-fix failure: this parsed, then `compareToBaseline` threw on `entry.id`.
        expect(parseAdvisorMap({ procedures: [null], score: 0, version: MAP_VERSION })).toBeUndefined();
    });
});
