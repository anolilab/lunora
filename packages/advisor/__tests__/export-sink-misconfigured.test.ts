import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorExportSink } from "../src";
import { fromServerSchema } from "../src";
import exportSinkMisconfigured from "../src/lints/static/export-sink-misconfigured";

const schema = () =>
    fromServerSchema(
        defineSchema({
            events: defineTable({ kind: v.string() }),
        }),
    );

const run = (exportSinks?: AdvisorExportSink[]) => exportSinkMisconfigured.run({ exportSinks, schema: schema() });

const sink = (overrides: Partial<AdvisorExportSink>): AdvisorExportSink => {
    return {
        analyzable: true,
        emptyKeys: [],
        factory: "webhookExportSink",
        file: "sinks",
        line: 3,
        presentKeys: [],
        ...overrides,
    };
};

describe("export_sink_misconfigured", () => {
    it("finds nothing when no sink evidence is supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(run()).toHaveLength(0);
    });

    it("flags a webhook sink missing its url", () => {
        expect.assertions(2);

        const findings = run([sink({ factory: "webhookExportSink", presentKeys: ["name"] })]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "export_sink_misconfigured:sinks:3:url",
            categories: ["SCHEMA"],
            level: "ERROR",
            metadata: { factory: "webhookExportSink", field: "url", file: "sinks", line: 3 },
            name: "export_sink_misconfigured",
        });
    });

    it("flags an r2 sink missing its bucket binding", () => {
        expect.assertions(1);

        const findings = run([sink({ factory: "r2Sink", presentKeys: ["name", "prefix"] })]);

        expect(findings.some((finding) => finding.metadata["field"] === "bucket")).toBe(true);
    });

    it("flags a present-but-empty required field", () => {
        expect.assertions(1);

        const findings = run([sink({ factory: "webhookExportSink", emptyKeys: ["url"], presentKeys: ["name", "url"] })]);

        expect(findings).toHaveLength(1);
    });

    it("is clean for a fully-configured webhook sink", () => {
        expect.assertions(1);

        expect(run([sink({ factory: "webhookExportSink", presentKeys: ["name", "url"] })])).toHaveLength(0);
    });

    it("is clean for a fully-configured defineExportSink", () => {
        expect.assertions(1);

        expect(run([sink({ factory: "defineExportSink", presentKeys: ["name", "deliver"] })])).toHaveLength(0);
    });

    it("skips a non-analyzable config (a variable / spread) rather than false-alarming", () => {
        expect.assertions(1);

        expect(run([sink({ analyzable: false, factory: "r2Sink", presentKeys: [] })])).toHaveLength(0);
    });
});
