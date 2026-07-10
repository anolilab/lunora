/**
 * Regression: the degraded-type-checker heuristic must not fire on the string
 * literal `"any"` (a common discriminant / union member) or on a property *key*
 * named `any`. Before the fix, `/\bany\b/` matched inside `kind: "any"` and on
 * the key `any`, erasing a perfectly-resolved return type to `unknown` and
 * silently breaking client-side inference for that function. A genuine `any`
 * type must still degrade.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions } from "../src/discover-functions";

let workdir: string;

describe("aNY_TOKEN_RE degraded-mode detection", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-any-token-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("keeps a return type carrying a `\"any\"` literal or a property named `any`, but still degrades a real `any`", () => {
        expect.assertions(5);

        writeFunction(
            "messages.ts",
            `
            import { query } from "@lunora/server";
            export const kindAny = query({
                args: {},
                handler: (): { kind: "any"; id: string } => ({ kind: "any", id: "x" }),
            });
            export const keyAny = query({
                args: {},
                handler: (): { any: number } => ({ any: 1 }),
            });
            export const realAny = query({
                args: {},
                handler: (): { x: any } => ({ x: 1 }),
            });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const byName = new Map(discoverFunctions(project, workdir).map((fn) => [fn.exportName, fn]));

        // The `"any"` discriminant literal survives (was erased to `unknown`).
        expect(byName.get("kindAny")?.returnType).not.toBe("unknown");
        expect(byName.get("kindAny")?.returnType).toContain('kind: "any"');
        // A property KEY named `any` survives (was erased to `unknown`).
        expect(byName.get("keyAny")?.returnType).not.toBe("unknown");
        expect(byName.get("keyAny")?.returnType).toContain("any: number");
        // A genuine `any` type still degrades to `unknown`.
        expect(byName.get("realAny")?.returnType).toBe("unknown");
    });
});
