/**
 * Tests that discoverFunctions handles v.from(...) gracefully:
 * discovery succeeds and the arg is emitted with kind "from" (→ TypeScript type `unknown`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions, resolveStandardSchemaType } from "../src/discover-functions";
import { setStandardTypeResolver } from "../src/parse-validator";

let workdir: string;

describe("v.from() in codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-from-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        setStandardTypeResolver(undefined);
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("discovery succeeds and returns kind:from for v.from() args, adjacent v.* args unaffected", () => {
        expect.assertions(3);

        writeFunction(
            "messages.ts",
            `
            import { query } from "@lunora/server";
            const externalSchema = { "~standard": { version: 1, vendor: "fake", validate: (val) => ({ value: val }) } };
            export const list = query({
                args: { text: v.from(externalSchema), count: v.number() },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        expect(result).toHaveLength(1);
        // v.from() arg → kind: "from"
        expect(result[0]?.args.text).toEqual({ kind: "from" });
        // Adjacent v.number() arg still resolves correctly
        expect(result[0]?.args.count).toEqual({ kind: "number" });
    });

    it("recovers the wrapped schema's inferred type from ~standard.types.output", () => {
        expect.assertions(2);

        // LUNORA_ISSUES #22: `v.from()` is the advertised Standard Schema bridge
        // and works at runtime, but codegen typed every argument behind one as
        // `unknown` — which broke `ctx.run*` calls, made handler args implicitly
        // `any` under noImplicitAny, and gave generated clients untyped
        // arguments. Standard Schema v1 exposes `~standard.types` precisely so
        // tooling can recover the inferred type.
        setStandardTypeResolver(resolveStandardSchemaType);

        writeFunction(
            "messages.ts",
            `
            import { query, v } from "@lunora/server";

            interface Std<T> {
                "~standard": { types?: { input: T; output: T }; validate: (value: unknown) => { value: T }; vendor: string; version: 1 };
            }

            declare const emailSchema: Std<string>;

            export const list = query({
                args: { email: v.from(emailSchema), count: v.number() },
                handler: () => null,
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const [discovered] = discoverFunctions(project, workdir);

        expect(discovered?.args["email"]).toStrictEqual({ kind: "from", tsType: "string" });
        // The adjacent native validator is untouched.
        expect(discovered?.args["count"]).toStrictEqual({ kind: "number" });
    });

    it("stays on `unknown` when the wrapped schema declares no ~standard.types", () => {
        expect.assertions(1);

        // `types` is OPTIONAL in the spec, so a schema that omits it genuinely
        // carries no recoverable type — falling back beats inventing one.
        setStandardTypeResolver(resolveStandardSchemaType);

        writeFunction(
            "notes.ts",
            `
            import { query, v } from "@lunora/server";

            declare const opaque: { "~standard": { validate: (value: unknown) => { value: unknown }; vendor: string; version: 1 } };

            export const list = query({ args: { note: v.from(opaque) }, handler: () => null });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const [discovered] = discoverFunctions(project, workdir);

        expect(discovered?.args["note"]).toStrictEqual({ kind: "from" });
    });
});
