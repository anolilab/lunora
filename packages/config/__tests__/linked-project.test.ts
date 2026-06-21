import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LINKED_PROJECT_DIR, LINKED_PROJECT_FILE, readLinkedProject, writeLinkedProject } from "../src/linked-project";

describe("linked-project", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-linked-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("round-trips a written link, creating .lunora/ on demand", () => {
        expect.assertions(2);

        const path = writeLinkedProject(workdir, { env: "production", linkedAt: "2026-01-01T00:00:00.000Z", workerName: "w", workerUrl: "https://w.dev" });

        expect(path).toBe(join(workdir, LINKED_PROJECT_FILE));
        expect(readLinkedProject(workdir)).toStrictEqual({
            account: undefined,
            env: "production",
            linkedAt: "2026-01-01T00:00:00.000Z",
            workerName: "w",
            workerUrl: "https://w.dev",
        });
    });

    it("omits undefined/empty fields when writing", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://w.dev", env: "" });

        const link = readLinkedProject(workdir);

        expect(link?.env).toBeUndefined();
    });

    it("returns undefined for a missing link", () => {
        expect.assertions(1);

        expect(readLinkedProject(workdir)).toBeUndefined();
    });

    it("returns undefined for malformed JSON rather than throwing", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://w.dev" });
        writeFileSync(join(workdir, LINKED_PROJECT_DIR, "project.json"), "{ not json", "utf8");

        expect(readLinkedProject(workdir)).toBeUndefined();
    });
});
