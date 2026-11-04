import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAdvisorProceduresRequest } from "../../src/studio-host/advisor-procedures-handler";

const PROCEDURES = {
    procedures: [
        {
            exportName: "list",
            file: "todos",
            kind: "query",
            usesCaptcha: false,
            usesEmailGate: false,
            usesMask: false,
            usesRateLimit: false,
            usesRls: true,
            visibility: "public",
        },
    ],
};

describe("handleAdvisorProceduresRequest", () => {
    let projectRoot: string;
    let generatedDirectory: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-advisor-procedures-"));
        generatedDirectory = join(projectRoot, "lunora", "_generated");
        mkdirSync(generatedDirectory, { recursive: true });
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("serves the generated procedure list on GET", () => {
        expect.assertions(2);

        writeFileSync(join(generatedDirectory, "advisor-procedures.json"), JSON.stringify(PROCEDURES));

        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(200);
        expect(response.body).toStrictEqual(PROCEDURES);
    });

    it("answers 404 with a reason when codegen has not written the file yet", () => {
        expect.assertions(2);

        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(404);
        expect(response.body).toStrictEqual({
            error: "advisor-procedures.json is not generated; run `lunora codegen` with the advisor enabled (`lint` not `false`).",
        });
    });

    it("answers 500 when the file has no procedures array rather than an empty list", () => {
        expect.assertions(2);

        writeFileSync(join(generatedDirectory, "advisor-procedures.json"), JSON.stringify({ something: true }));

        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual({ error: "advisor-procedures.json has no procedures array; re-run `lunora codegen`." });
    });

    it("answers 500 when a procedure entry is malformed rather than letting the client cast it", () => {
        expect.assertions(2);

        writeFileSync(join(generatedDirectory, "advisor-procedures.json"), JSON.stringify({ procedures: [{ exportName: "list" }] }));

        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual({ error: "advisor-procedures.json has a malformed procedure entry; re-run `lunora codegen`." });
    });

    it("answers 500 when the file is not JSON", () => {
        expect.assertions(1);

        writeFileSync(join(generatedDirectory, "advisor-procedures.json"), "{ not json");

        expect(handleAdvisorProceduresRequest({ method: "GET", projectRoot }).status).toBe(500);
    });

    it("answers 500 when an entry is not a procedure object", () => {
        expect.assertions(2);

        writeFileSync(join(generatedDirectory, "advisor-procedures.json"), JSON.stringify({ procedures: [null] }));

        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual({ error: "advisor-procedures.json has a malformed procedure entry; re-run `lunora codegen`." });
    });

    it("reports a read failure as such and logs the cause", () => {
        expect.assertions(3);

        // A directory at the file's path exists but cannot be read as a file (EISDIR).
        mkdirSync(join(generatedDirectory, "advisor-procedures.json"));

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const response = handleAdvisorProceduresRequest({ method: "GET", projectRoot });

        expect(response.status).toBe(500);
        expect(response.body).toStrictEqual({ error: "advisor-procedures.json could not be read; see the dev server log." });
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("advisor-procedures.json"), expect.any(Error));

        consoleError.mockRestore();
    });

    it("refuses any method other than GET", () => {
        expect.assertions(1);

        expect(handleAdvisorProceduresRequest({ method: "POST", projectRoot }).status).toBe(405);
    });
});
