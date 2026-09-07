import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handlePolicyScaffoldRequest } from "../../src/studio-host/policy-scaffold-handler";

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

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
    let lunoraDirectory: string;

    const writeProjectFile = (relativePath: string, source: string): void => {
        const full = join(lunoraDirectory, relativePath);

        mkdirSync(lunoraDirectory, { recursive: true });
        writeFileSync(full, source, "utf8");
    };

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-policy-scaffold-"));
        lunoraDirectory = join(projectRoot, "lunora");
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
        expect(existsSync(join(lunoraDirectory, "invoices.policies.ts"))).toBe(true);
        expect(readFileSync(join(lunoraDirectory, "invoices.policies.ts"), "utf8")).toContain("when: () => false");
    });

    it("writes the stub but skips codegen when the codegen switch is off", () => {
        expect.assertions(3);

        // Same gate the schema editor reads: `lunora dev --no-codegen` travels as
        // LUNORA_CODEGEN=0, and a scaffold that regenerated anyway rewrote the
        // generated tree the flag had just excluded.
        process.env.LUNORA_CODEGEN = "0";

        try {
            const result = handlePolicyScaffoldRequest({
                body: { kind: "scaffoldPolicy", name: "invoices", table: "invoices" },
                method: "POST",
                projectRoot,
            });

            expect(result.status).toBe(200);
            expect(existsSync(join(lunoraDirectory, "invoices.policies.ts"))).toBe(true);
            expect(existsSync(join(lunoraDirectory, "_generated"))).toBe(false);
        } finally {
            delete process.env.LUNORA_CODEGEN;
        }
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
        expect(readFileSync(join(lunoraDirectory, "invoices.policies.ts"), "utf8")).toBe("export const invoicesPolicies = [];\n");
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
        expect(readFileSync(join(lunoraDirectory, "invoices.ts"), "utf8")).toContain(".use(rls(invoicesPolicies))");
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

    it("rejects a POST body of literal null with a 400 (not a 500 TypeError)", () => {
        expect.assertions(2);

        const result = handlePolicyScaffoldRequest({ body: null, method: "POST", projectRoot });

        expect(result.status).toBe(400);
        expect(result.body).toStrictEqual({ error: "invalid-edit", ok: false });
    });

    it("rejects an unsupported HTTP method", () => {
        expect.assertions(1);

        expect(handlePolicyScaffoldRequest({ method: "GET", projectRoot }).status).toBe(405);
    });
});
