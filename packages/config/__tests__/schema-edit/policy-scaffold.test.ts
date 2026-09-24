import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ScaffoldFileResult, WireResult } from "../../src/schema-edit/policy-scaffold";
import { classifyPolicyEdit, resolveServerModule, scaffoldPolicyFile, wireRlsIntoProcedure } from "../../src/schema-edit/policy-scaffold";

const BUILDER_PROCEDURE = `import { c } from "./_generated/server";

export const listInvoices = c
    .input({ ownerId: "v.string()" })
    .query(async ({ ctx }) => ctx.db.query("invoices").collect());
`;

/** Narrow a scaffold result to its success shape, failing the test if it did not apply. */
const okScaffold = (result: ScaffoldFileResult): Extract<ScaffoldFileResult, { ok: true }> => {
    if (!result.ok) {
        throw new Error(`expected ok scaffold, got ${result.reason}`);
    }

    return result;
};

/** Narrow a wire result to its success shape, failing the test if it did not apply. */
const okWire = (result: WireResult): Extract<WireResult, { ok: true }> => {
    if (!result.ok) {
        throw new Error(`expected ok wire, got ${result.reason}`);
    }

    return result;
};

describe("scaffoldPolicyFile", () => {
    it("emits a deny-by-default stub with policies, a permission, and a role", () => {
        expect.assertions(6);

        const result = okScaffold(scaffoldPolicyFile({ kind: "scaffoldPolicy", name: "invoices", table: "invoices" }, "@lunora/server"));

        expect(result.ok).toBe(true);
        expect(result.fileName).toBe("invoices.policies.ts");
        expect(result.source).toContain("export const invoicesPolicies = definePolicies([");
        // The predicate is a deny-by-default skeleton — never authored logic.
        expect(result.source).toContain("when: () => false");
        expect(result.source).toContain('export const invoicesView = definePermission("invoices:view");');
        expect(result.source).toContain('defineRole("invoices-admin"');
    });

    it("rejects a name that is not a JS identifier", () => {
        expect.assertions(1);

        const result = scaffoldPolicyFile({ kind: "scaffoldPolicy", name: "in voices", table: "invoices" }, "@lunora/server");

        expect(result).toStrictEqual({ ok: false, reason: "invalid-identifier" });
    });

    it("rejects a table that could break out of the generated comment", () => {
        expect.assertions(1);

        // `table` is interpolated raw into the stub's JSDoc; a `*/`-bearing value
        // must be refused, not allowed to inject code into the generated file.
        const result = scaffoldPolicyFile({ kind: "scaffoldPolicy", name: "invoices", table: "x */ process.exit(1); /*" }, "@lunora/server");

        expect(result).toStrictEqual({ ok: false, reason: "invalid-identifier" });
    });
});

describe("resolveServerModule", () => {
    it("picks the umbrella subpath for an umbrella-only project and the granular package otherwise", () => {
        expect.assertions(3);

        const umbrella = mkdtempSync(join(tmpdir(), "lunora-policy-umbrella-"));
        const granular = mkdtempSync(join(tmpdir(), "lunora-policy-granular-"));
        const empty = mkdtempSync(join(tmpdir(), "lunora-policy-empty-"));

        writeFileSync(join(umbrella, "package.json"), JSON.stringify({ dependencies: { lunorash: "^1.0.0" } }));
        writeFileSync(join(granular, "package.json"), JSON.stringify({ dependencies: { "@lunora/server": "^1.0.0" } }));

        expect(resolveServerModule(umbrella)).toBe("lunorash/server");
        expect(resolveServerModule(granular)).toBe("@lunora/server");
        // No readable package.json → the granular default, as before.
        expect(resolveServerModule(empty)).toBe("@lunora/server");
    });
});

describe("umbrella projects", () => {
    it("scaffolds the specifier the project can resolve, and never adds the other one", () => {
        expect.assertions(4);

        // An umbrella-only install has no `@lunora/server` on disk, so a stub
        // importing it cannot be bundled — the worker breaks on a file the studio
        // wrote. `resolveServerModule` reads the project's own dependencies.
        const scaffolded = okScaffold(scaffoldPolicyFile({ kind: "scaffoldPolicy", name: "invoices", table: "invoices" }, "lunorash/server"));

        expect(scaffolded.source).toContain('from "lunorash/server"');
        expect(scaffolded.source).not.toContain('from "@lunora/server"');

        // Wiring a file that already imports the umbrella spelling extends THAT
        // import rather than adding a second, granular one beside it.
        const wired = okWire(
            wireRlsIntoProcedure(
                'import { c } from "lunorash/server";\n\nexport const listInvoices = c.query(async () => []);\n',
                { exportName: "listInvoices", kind: "wireRls", policies: "invoicesPolicies" },
                "lunorash/server",
            ),
        );

        expect(wired.text).toMatch(/import \{[^}]*\brls\b[^}]*\} from "lunorash\/server"/u);
        expect(wired.text).not.toContain('"@lunora/server"');
    });
});

describe("wireRlsIntoProcedure", () => {
    it("appends .use(rls(policies)) to a builder chain, preserves the handler, and imports rls", () => {
        expect.assertions(4);

        const result = okWire(
            wireRlsIntoProcedure(BUILDER_PROCEDURE, { exportName: "listInvoices", kind: "wireRls", policies: "invoicesPolicies" }, "@lunora/server"),
        );

        expect(result.ok).toBe(true);
        expect(result.text).toContain(".use(rls(invoicesPolicies))");
        // The terminal call + its handler body survive untouched.
        expect(result.text).toContain('.query(async ({ ctx }) => ctx.db.query("invoices").collect())');
        // `rls` is now importable so codegen still recognises the procedure.
        expect(result.text).toMatch(/import \{[^}]*\brls\b[^}]*\} from "@lunora\/server"/u);
    });

    it("reports a procedure that is already wired", () => {
        expect.assertions(1);

        const source = `import { c, rls } from "./_generated/server";

export const listInvoices = c.use(rls(invoicesPolicies)).query(async () => []);
`;

        expect(wireRlsIntoProcedure(source, { exportName: "listInvoices", kind: "wireRls", policies: "invoicesPolicies" }, "@lunora/server")).toStrictEqual({
            ok: false,
            reason: "already-wired",
        });
    });

    it("refuses to wire the bare-factory form (no chain to extend)", () => {
        expect.assertions(1);

        const source = `import { query } from "./_generated/server";

export const listInvoices = query({ args: {}, handler: async () => [] });
`;

        expect(wireRlsIntoProcedure(source, { exportName: "listInvoices", kind: "wireRls", policies: "invoicesPolicies" }, "@lunora/server")).toStrictEqual({
            ok: false,
            reason: "unsupported-procedure-shape",
        });
    });

    it("reports an unknown procedure name", () => {
        expect.assertions(1);

        expect(
            wireRlsIntoProcedure(BUILDER_PROCEDURE, { exportName: "missing", kind: "wireRls", policies: "invoicesPolicies" }, "@lunora/server"),
        ).toStrictEqual({
            ok: false,
            reason: "unknown-procedure",
        });
    });

    it("rejects a policy-set identifier that is not a JS identifier", () => {
        expect.assertions(1);

        expect(
            wireRlsIntoProcedure(BUILDER_PROCEDURE, { exportName: "listInvoices", kind: "wireRls", policies: "not an ident" }, "@lunora/server"),
        ).toStrictEqual({
            ok: false,
            reason: "invalid-identifier",
        });
    });
});

describe("classifyPolicyEdit", () => {
    it("treats scaffold + wire as additive and a when-rewrite as destructive", () => {
        expect.assertions(3);

        expect(classifyPolicyEdit({ kind: "scaffoldPolicy", name: "a", table: "a" })).toBe("additive");
        expect(classifyPolicyEdit({ exportName: "x", kind: "wireRls", policies: "p" })).toBe("additive");
        expect(classifyPolicyEdit({ kind: "rewritePolicyWhen", table: "a" })).toBe("destructive");
    });
});
