import { describe, expect, it } from "vitest";

import type { AdvisorProcedureProtection, LintContext } from "../src";
import { actionWithoutErrorHandling, aiRunWithoutLogging, errorWithoutCatalog, procedureWithoutStructuredEvent } from "../src";

/** A procedure as the feeder supplies it; every observability fact defaults to "analyzed, absent". */
const procedure = (overrides: Partial<AdvisorProcedureProtection> & Pick<AdvisorProcedureProtection, "exportName" | "file">): AdvisorProcedureProtection => {
    return {
        callsMail: false,
        emitsEvent: false,
        fanOut: false,
        handlesErrors: false,
        kind: "mutation",
        reachesOutbound: false,
        throwsBareError: false,
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

const contextWith = (procedures: AdvisorProcedureProtection[], extra: Partial<LintContext> = {}): LintContext => {
    return { procedureProtections: procedures, schema: { tables: [] }, ...extra };
};

describe("procedure_without_structured_event", () => {
    it("flags a public write that emits nothing", () => {
        expect.assertions(2);

        const findings = procedureWithoutStructuredEvent.run(contextWith([procedure({ exportName: "sendMessage", file: "messages" })]));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.metadata).toMatchObject({ exportName: "sendMessage", file: "messages" });
    });

    it("passes once the handler emits an event", () => {
        expect.assertions(1);

        expect(procedureWithoutStructuredEvent.run(contextWith([procedure({ emitsEvent: true, exportName: "a", file: "f" })]))).toHaveLength(0);
    });

    it("ignores reads and internal writes", () => {
        expect.assertions(1);

        const findings = procedureWithoutStructuredEvent.run(
            contextWith([
                procedure({ exportName: "read", file: "f", kind: "query" }),
                procedure({ exportName: "internal", file: "f", visibility: "internal" }),
            ]),
        );

        expect(findings).toHaveLength(0);
    });

    it("stays quiet when the feeder could not read the body", () => {
        expect.assertions(1);

        // `undefined` is "unknown", not "absent" — nagging on it would punish an
        // unanalyzable handler for something we never observed.
        expect(procedureWithoutStructuredEvent.run(contextWith([procedure({ emitsEvent: undefined, exportName: "a", file: "f" })]))).toHaveLength(0);
    });

    it("finds nothing without feeder evidence", () => {
        expect.assertions(1);

        expect(procedureWithoutStructuredEvent.run({ schema: { tables: [] } })).toHaveLength(0);
    });
});

describe("error_without_catalog", () => {
    it("flags a bare `new Error(...)`", () => {
        expect.assertions(2);

        const findings = errorWithoutCatalog.run(contextWith([procedure({ exportName: "a", file: "f", throwsBareError: true })]));

        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe("WARN");
    });

    it("passes a procedure that throws a coded error", () => {
        expect.assertions(1);

        expect(errorWithoutCatalog.run(contextWith([procedure({ exportName: "a", file: "f" })]))).toHaveLength(0);
    });
});

describe("action_without_error_handling", () => {
    it("flags an action reaching outbound with no try/catch", () => {
        expect.assertions(1);

        const findings = actionWithoutErrorHandling.run(
            contextWith([procedure({ exportName: "sync", file: "stripe", kind: "action", reachesOutbound: true })]),
        );

        expect(findings).toHaveLength(1);
    });

    it("passes once the action catches", () => {
        expect.assertions(1);

        const findings = actionWithoutErrorHandling.run(
            contextWith([procedure({ exportName: "sync", file: "stripe", handlesErrors: true, kind: "action", reachesOutbound: true })]),
        );

        expect(findings).toHaveLength(0);
    });

    it("ignores mutations, which cannot reach those surfaces", () => {
        expect.assertions(1);

        expect(actionWithoutErrorHandling.run(contextWith([procedure({ exportName: "a", file: "f", reachesOutbound: true })]))).toHaveLength(0);
    });
});

describe("ai_run_without_logging", () => {
    it("flags a raw AI run in a procedure that emits nothing", () => {
        expect.assertions(1);

        const findings = aiRunWithoutLogging.run(
            contextWith([procedure({ exportName: "ask", file: "ai", kind: "action" })], { aiRawRuns: [{ exportName: "ask", file: "ai", line: 3 }] }),
        );

        expect(findings).toHaveLength(1);
    });

    it("also flags an unbounded generation with no event, without a raw-run row", () => {
        expect.assertions(1);

        const findings = aiRunWithoutLogging.run(
            contextWith([procedure({ exportName: "ask", file: "ai", kind: "action", unboundedAiGeneration: true })], { aiRawRuns: [] }),
        );

        expect(findings).toHaveLength(1);
    });

    it("passes once the generation is logged", () => {
        expect.assertions(1);

        const findings = aiRunWithoutLogging.run(
            contextWith([procedure({ emitsEvent: true, exportName: "ask", file: "ai", kind: "action", unboundedAiGeneration: true })], { aiRawRuns: [] }),
        );

        expect(findings).toHaveLength(0);
    });

    it("finds nothing when no AI evidence was supplied", () => {
        expect.assertions(1);

        expect(aiRunWithoutLogging.run(contextWith([procedure({ exportName: "a", file: "f" })]))).toHaveLength(0);
    });
});
