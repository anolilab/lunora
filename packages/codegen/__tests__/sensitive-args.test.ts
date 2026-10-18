/**
 * `v.sensitive(...)` as the build-time sees it: the IR records the marker, the
 * registry and the shard carry the argument NAMES (never the value), the api
 * reference is typed `sensitive`, and the JSON Schema is write-only. Every case
 * uses an innocuously named argument, `value`, because the marker is what counts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../src/discover/functions";
import { emitApi, emitFunctions, emitShard } from "../src/emit";
import type { FunctionIR, ValidatorIR } from "../src/ir";
import { parseValidator, validatorContainsSensitive } from "../src/parse-validator";
import { validatorIrToJsonSchema } from "../src/schema-ir";

const makeFunction = (overrides: Partial<FunctionIR> = {}): FunctionIR => {
    return {
        args: { label: { kind: "string" }, value: { kind: "string", sensitive: true } },
        exportName: "store",
        filePath: "vault",
        kind: "mutation",
        returnType: "{ ok: boolean }",
        ...overrides,
    };
};

const sensitiveString: ValidatorIR = { kind: "string", sensitive: true };

describe("v.sensitive in the build-time IR", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-sensitive-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("records the marker on the arg and keeps the wrapped kind", () => {
        expect.assertions(3);

        writeFunction(
            "vault.ts",
            `
            import { mutation, v } from "@lunora/server";
            export const store = mutation({
                args: { label: v.string(), value: v.sensitive(v.string()) },
                handler: () => ({ ok: true }),
            });
        `,
        );

        const [definition] = discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true }), workdir);

        expect(definition?.args["value"]).toStrictEqual({ kind: "string", sensitive: true });
        expect(definition?.args["label"]).toStrictEqual({ kind: "string" });
        expect(validatorContainsSensitive(definition?.args["value"] ?? { kind: "any" })).toBe(true);
    });

    it("sees a marker nested under an object or optional wrapper, and not on a plain tree", () => {
        expect.assertions(2);

        const nested = parseValidator(
            new Project({ skipAddingFilesFromTsConfig: true })
                .createSourceFile("nested.ts", "const x = v.optional(v.object({ inner: v.sensitive(v.string()) }));", { overwrite: true })
                .getVariableDeclarationOrThrow("x")
                .getInitializerOrThrow(),
        );

        expect(validatorContainsSensitive(nested)).toBe(true);
        expect(validatorContainsSensitive({ kind: "object", shape: { inner: { kind: "string" } } })).toBe(false);
    });

    it("writes the arg write-only in the JSON Schema, and only that arg", () => {
        expect.assertions(2);

        expect(validatorIrToJsonSchema(sensitiveString)).toStrictEqual({ format: "password", type: "string", writeOnly: true });
        expect(validatorIrToJsonSchema({ kind: "string" })).toStrictEqual({ type: "string" });
    });
});

describe("emitted artifacts for a sensitive function", () => {
    it("types the api reference as sensitive and carries the flag at runtime", () => {
        expect.assertions(2);

        const rendered = emitApi({ functions: [makeFunction()] });

        expect(rendered).toContain('store: FunctionReference<"mutation", { label: string; value: string }, { ok: boolean }> & { readonly sensitive: true };');
        expect(rendered).toContain('{ __lunoraRef: "vault:store", sensitive: true }');
    });

    it("leaves a plain function's reference untouched", () => {
        expect.assertions(2);

        const rendered = emitApi({ functions: [makeFunction({ args: { label: { kind: "string" } } })] });

        expect(rendered).not.toContain("sensitive");
        expect(rendered).toContain('{ __lunoraRef: "vault:store" }');
    });

    it("lists the sensitive argument names on a lazy stub and flags the descriptor", () => {
        expect.assertions(3);

        const emitted = emitFunctions({ functions: [makeFunction()], lazyFunctions: true });

        expect(emitted).toContain('"sensitiveArgs":["value"]');
        expect(emitted).toContain('"name":"value","optional":false,"sensitive":true');
        expect(emitted).toContain("sensitiveArgs?: readonly string[];");
    });

    it("emits no sensitive field at all for a project without a sensitive argument", () => {
        expect.assertions(2);

        const emitted = emitFunctions({ functions: [makeFunction({ args: { label: { kind: "string" } } })], lazyFunctions: true });

        expect(emitted).not.toContain("sensitive");
        expect(emitted).not.toContain("sensitiveArgs");
    });

    it("wires the shard's sensitiveArgNames override only when a sensitive argument exists", () => {
        expect.assertions(4);

        const schema = { tables: [], vectorIndexes: [] };
        const withSecret = emitShard({ hasSensitiveArgs: true, schema });
        const without = emitShard({ schema });

        expect(withSecret).toContain("protected override sensitiveArgNames(functionPath: string): ReadonlySet<string>");
        expect(withSecret).toContain('import { sensitiveArgumentNames } from "@lunora/values";');
        expect(without).not.toContain("sensitiveArgNames");
        expect(without).not.toContain("sensitiveArgumentNames");
    });
});
