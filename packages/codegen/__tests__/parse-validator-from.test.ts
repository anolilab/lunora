/**
 * Tests that discoverFunctions handles v.from(...) gracefully:
 * discovery succeeds and the arg is emitted with kind "from" (→ TypeScript type `unknown`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions } from "../src/discover-functions";

let workdir: string;

describe("v.from() in codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-from-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
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
            import { query } from "@cirrus/server";
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
});
