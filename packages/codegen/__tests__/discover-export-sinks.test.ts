import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverExportSinks from "../src/discover-export-sinks";

const SINKS = `
    import { defineExportSink, r2Sink, webhookExportSink } from "@lunora/runtime";

    // Well-configured webhook sink.
    export const good = webhookExportSink({ name: "warehouse", url: "https://example.com/cdc" });

    // Missing url.
    export const noUrl = webhookExportSink({ name: "warehouse" });

    // Empty url string.
    export const emptyUrl = webhookExportSink({ name: "warehouse", url: "" });

    // R2 sink missing its bucket binding.
    export const r2 = r2Sink({ name: "backup", prefix: "cdc" });

    // Custom sink missing deliver.
    export const custom = defineExportSink({ name: "custom" });

    // Non-analyzable: spread config could supply the keys.
    const base = { name: "x", url: "https://x.test" };
    export const spread = webhookExportSink({ ...base });
`;

let workdir: string;
let project: Project;

describe("discoverExportSinks", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-export-sinks-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "sinks.ts"), SINKS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records each sink factory with its present config keys", () => {
        expect.assertions(2);

        const sinks = discoverExportSinks(project, join(workdir, "lunora"));

        expect(sinks.filter((sink) => sink.factory === "webhookExportSink")).toHaveLength(4);

        const good = sinks.find((sink) => sink.presentKeys.includes("url") && sink.presentKeys.includes("name") && sink.emptyKeys.length === 0);

        expect(good?.factory).toBe("webhookExportSink");
    });

    it("records an empty-string config value in emptyKeys", () => {
        expect.assertions(1);

        const sinks = discoverExportSinks(project, join(workdir, "lunora"));
        const empty = sinks.find((sink) => sink.emptyKeys.includes("url"));

        expect(empty).toBeDefined();
    });

    it("records the r2 sink's present keys (bucket absent)", () => {
        expect.assertions(1);

        const sinks = discoverExportSinks(project, join(workdir, "lunora"));
        const r2 = sinks.find((sink) => sink.factory === "r2Sink");

        expect(r2?.presentKeys).not.toContain("bucket");
    });

    it("marks a spread config as non-analyzable", () => {
        expect.assertions(1);

        const sinks = discoverExportSinks(project, join(workdir, "lunora"));
        const spread = sinks.filter((sink) => sink.factory === "webhookExportSink").find((sink) => !sink.analyzable);

        expect(spread).toBeDefined();
    });
});
