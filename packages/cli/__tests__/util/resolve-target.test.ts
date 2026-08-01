import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeLinkedProject } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveProductionWorkerUrl, resolveWorkerUrl } from "../../src/util/resolve-target";

describe("resolveWorkerUrl", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-resolve-target-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns the explicit --url flag even when it would otherwise resolve differently", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "production", workerUrl: "https://linked.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: "production", url: "https://explicit.example.com" })).toBe("https://explicit.example.com");
    });

    it("treats an empty-string --url as absent and falls through to the link", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://linked.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: undefined, url: "" })).toBe("https://linked.workers.dev");
    });

    it("returns undefined when no link exists and no --url was passed", () => {
        expect.assertions(1);

        expect(resolveWorkerUrl({ cwd: workdir, env: undefined })).toBeUndefined();
    });

    it("returns the link's URL when the link's env matches the requested (top-level) env", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://linked.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: undefined })).toBe("https://linked.workers.dev");
    });

    it("returns the link's URL when the link's env matches the requested scoped env", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "staging", workerUrl: "https://staging.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: "staging" })).toBe("https://staging.workers.dev");
    });

    it("returns undefined when a production-linked checkout is targeted with --env staging", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "production", workerUrl: "https://prod.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: "staging" })).toBeUndefined();
    });

    it("returns undefined when a scoped link is targeted at the top level (no --env)", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "staging", workerUrl: "https://staging.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: undefined })).toBeUndefined();
    });

    it("returns undefined when a top-level link is targeted with a named --env", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://top-level.workers.dev" });

        expect(resolveWorkerUrl({ cwd: workdir, env: "production" })).toBeUndefined();
    });
});

describe("resolveProductionWorkerUrl", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-resolve-target-prod-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns the explicit --url flag regardless of --prod", () => {
        expect.assertions(1);

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: false, url: "https://explicit.example.com" })).toBe("https://explicit.example.com");
    });

    it("returns undefined without --prod even when a production link exists", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://prod.workers.dev" });

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: false })).toBeUndefined();
    });

    it("returns the link's URL with --prod when the link is unscoped (top-level)", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://prod.workers.dev" });

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: true })).toBe("https://prod.workers.dev");
    });

    it("returns the link's URL with --prod when the link is explicitly scoped to production", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "production", workerUrl: "https://prod.workers.dev" });

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: true })).toBe("https://prod.workers.dev");
    });

    it("returns undefined with --prod when the link is scoped to a non-production environment", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { env: "staging", workerUrl: "https://staging.workers.dev" });

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: true })).toBeUndefined();
    });

    it("returns undefined with --prod when no link exists", () => {
        expect.assertions(1);

        expect(resolveProductionWorkerUrl({ cwd: workdir, prod: true })).toBeUndefined();
    });
});
