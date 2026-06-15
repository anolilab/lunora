import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handlePolicyScaffoldRequest } from "../../src/studio-host/policy-scaffold-handler";

const SCHEMA = `import { defineSchema, defineTable, v } from "@cirrus/server";

export default defineSchema({
    invoices: defineTable({
        total: v.number(),
    }),
});
`;

const PROCEDURE = `import { c } from "./_generated/server";

export const listInvoices = c.query(async ({ ctx }) => ctx.db.query("invoices").collect());
`;

// eslint-disable-next-line no-secrets/no-secrets -- the handler's function name, not a credential
describe("handlePolicyScaffoldRequest", () => {
    let projectRoot: string;
    let cirrusDirectory: string;

    const writeProjectFile = (relativePath: string, source: string): void => {
        const full = join(cirrusDirectory, relativePath);

        mkdirSync(cirrusDirectory, { recursive: true });
        writeFileSync(full, source, "utf8");
    };

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "cirrus-policy-scaffold-"));
        cirrusDirectory = join(projectRoot, "cirrus");
        writeProjectFile("schema.ts", SCHEMA);
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("writes a new policy stub file on a scaffoldPolicy POST", () => {
        expect.assertions(3);

        const result = handlePolicyScaffoldRequest({
            body: { kind: "scaffoldPolicy", name: "invoices", table: "invoices" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(200);
        expect(existsSync(join(cirrusDirectory, "invoices.policies.ts"))).toBe(true);
        expect(readFileSync(join(cirrusDirectory, "invoices.policies.ts"), "utf8")).toContain("when: () => false");
    });

    it("refuses to overwrite an existing policy file", () => {
        expect.assertions(2);

        writeProjectFile("invoices.policies.ts", "export const invoicesPolicies = [];\n");

        const result = handlePolicyScaffoldRequest({
            body: { kind: "scaffoldPolicy", name: "invoices", table: "invoices" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(409);
        // The developer's existing file is left untouched.
        expect(readFileSync(join(cirrusDirectory, "invoices.policies.ts"), "utf8")).toBe("export const invoicesPolicies = [];\n");
    });

    it("appends .use(rls(...)) to an existing procedure on a wireRls POST", () => {
        expect.assertions(2);

        writeProjectFile("invoices.ts", PROCEDURE);

        const result = handlePolicyScaffoldRequest({
            body: { exportName: "listInvoices", filePath: "invoices", kind: "wireRls", policies: "invoicesPolicies" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(200);
        expect(readFileSync(join(cirrusDirectory, "invoices.ts"), "utf8")).toContain(".use(rls(invoicesPolicies))");
    });

    it("returns 404 when the procedure file is missing", () => {
        expect.assertions(1);

        const result = handlePolicyScaffoldRequest({
            body: { exportName: "listInvoices", filePath: "missing", kind: "wireRls", policies: "invoicesPolicies" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(404);
    });

    it("rejects a path-traversal filePath", () => {
        expect.assertions(1);

        const result = handlePolicyScaffoldRequest({
            body: { exportName: "x", filePath: "../../escape", kind: "wireRls", policies: "p" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(404);
    });

    it("refuses a destructive rewrite without writing anything", () => {
        expect.assertions(2);

        const result = handlePolicyScaffoldRequest({
            body: { kind: "rewritePolicyWhen", table: "invoices" },
            method: "POST",
            projectRoot,
        });
        const body = result.body as { needsManualEdit?: boolean };

        expect(result.status).toBe(409);
        expect(body.needsManualEdit).toBe(true);
    });

    it("rejects a POST body without a kind", () => {
        expect.assertions(1);

        expect(handlePolicyScaffoldRequest({ body: { name: "x" }, method: "POST", projectRoot }).status).toBe(400);
    });

    it("rejects an unsupported HTTP method", () => {
        expect.assertions(1);

        expect(handlePolicyScaffoldRequest({ method: "GET", projectRoot }).status).toBe(405);
    });
});
