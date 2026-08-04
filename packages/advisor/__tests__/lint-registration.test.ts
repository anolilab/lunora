import { describe, expect, it } from "vitest";

// eslint-disable-next-line import/no-namespace -- enumerating the barrel IS this test: it asserts every exported lint is registered, so it must see the whole namespace rather than a named subset that could drift.
import * as advisor from "../src";

type Lint = (typeof advisor.ALL_LINTS)[number];

/** A value exported from `../src` is a {@link Lint} when it carries the rule shape. */
const isLint = (value: unknown): value is Lint =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { run?: unknown }).run === "function" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { source?: unknown }).source === "string";

describe("lint registration completeness", () => {
    it("registers every exported lint in ALL_LINTS (no orphan lint that never runs)", () => {
        expect.hasAssertions();

        const registered = new Set<Lint>(advisor.ALL_LINTS);

        for (const [exportName, value] of Object.entries(advisor)) {
            if (!isLint(value)) {
                continue;
            }

            // An exported lint absent from ALL_LINTS — the default set `runAdvisor`
            // uses — never runs in production, however complete its own tests are.
            expect(registered.has(value), `exported lint "${exportName}" (${value.name}) is missing from ALL_LINTS`).toBe(true);
        }
    });

    it("runs the external_source_* lints through the default static set (regression: they were exported but unregistered)", () => {
        expect.assertions(3);

        expect(advisor.ALL_LINTS).toContain(advisor.externalSourceUnscoped);
        expect(advisor.ALL_LINTS).toContain(advisor.externalSourceOnGlobal);

        // A `.source()` + `.shardBy()` table without `tenantBy` is a cross-tenant
        // leak the ERROR-level `external_source_unscoped` lint must surface via
        // `runAdvisor` (not only via the lint's own `.run`).
        const findings = advisor.runAdvisor(
            {
                schema: {
                    tables: [
                        {
                            externalSource: { hasTenantBy: false },
                            fields: [],
                            indexes: [],
                            name: "orders",
                            relations: [],
                            shardKind: "shardBy",
                        },
                    ],
                },
            },
            { source: "static" },
        );

        expect(findings.some((finding) => finding.name === "external_source_unscoped" && finding.level === "ERROR")).toBe(true);
    });
});
