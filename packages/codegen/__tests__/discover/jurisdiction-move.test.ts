import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertJurisdictionMoveAcknowledged, findDoAuthDeclaration } from "../../src/discover/jurisdiction-move";
import discoverSchema from "../../src/discover/schema";
import type { SchemaIR } from "../../src/ir";

/**
 * Upgrading an app that already declares `.jurisdiction()` changes nothing in
 * its schema, so no drift gate fires — yet DO-backed auth, which was never
 * pinned, would now resolve to a new, empty object: every user locked out.
 * Codegen must refuse that until the schema acknowledges the move. Voice
 * sessions store nothing (transcripts are rows in the already-pinned shards),
 * so they are pinned without an acknowledgement.
 */
describe("jurisdiction move of DO-backed auth", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-jurisdiction-move-"));
        mkdirSync(join(root, "lunora"), { recursive: true });
        mkdirSync(join(root, "src"), { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const schemaWith = (chain: string): SchemaIR => {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

        project.createSourceFile(
            "/virtual/lunora/schema.ts",
            `import { defineSchema, defineTable, v } from "@lunora/server";\nexport default defineSchema({ notes: defineTable({ body: v.string() }) })${chain};`,
        );

        return discoverSchema(project, "/virtual/lunora/schema.ts");
    };

    const entryWithAuth = (auth: string): ReturnType<typeof findDoAuthDeclaration> => {
        writeFileSync(join(root, "src", "index.ts"), `import { app } from "./app";\nexport default app.auth(${auth}).build();\n`);

        return findDoAuthDeclaration(new Project({ skipAddingFilesFromTsConfig: true }), join(root, "lunora"));
    };

    it("reads the acknowledgement off the schema chain", () => {
        expect.assertions(3);

        expect(schemaWith(`.jurisdiction("eu")`).jurisdictionPinsAuth).toBeUndefined();
        expect(schemaWith(`.jurisdiction("eu", { pinAuth: true })`).jurisdictionPinsAuth).toBe(true);
        expect(schemaWith(`.jurisdiction("eu", { pinAuth: false })`).jurisdictionPinsAuth).toBeUndefined();
    });

    it("refuses DO-backed auth under an unacknowledged jurisdiction, at the .auth() call", () => {
        expect.assertions(1);

        const declaration = entryWithAuth(`{ namespace: (env) => env.AUTH, options: () => ({}) }`);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), declaration);
        }).toThrow(/DO-backed auth[\s\S]*NEW, EMPTY object[\s\S]*pinAuth: true[\s\S]*src\/index\.ts:2/u);
    });

    it("pins voice sessions without an acknowledgement: they store nothing to lose", () => {
        expect.assertions(1);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), undefined);
        }).not.toThrow();
    });

    it("accepts DO-backed auth once acknowledged, and projects without it", () => {
        expect.assertions(3);

        const declaration = entryWithAuth(`{ namespace: (env) => env.AUTH, options: () => ({}) }`);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu", { pinAuth: true })`), declaration);
        }).not.toThrow();
        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), undefined);
        }).not.toThrow();
        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(""), declaration);
        }).not.toThrow();
    });

    it("reads a computed `namespace` key, and fails toward DO-backed auth for one it cannot resolve", () => {
        expect.assertions(3);

        expect(entryWithAuth(`{ ["namespace"]: (env) => env.AUTH, options: () => ({}) }`)).toBeDefined();
        expect(entryWithAuth(`{ [key]: (env) => env.AUTH, options: () => ({}) }`)).toBeDefined();
        // A computed key that resolves to something else is not DO-backed auth.
        expect(entryWithAuth(`{ ["d1"]: (env) => env.DB, options: () => ({}) }`)).toBeUndefined();
    });

    it("finds DO-backed auth declared only in the root lunora.config.ts", () => {
        expect.assertions(1);

        // `@lunora/vite` runs the config's `app` hook over the worker's builder,
        // so `.auth(...)` there wires the deployed worker as well as one in the entry.
        writeFileSync(join(root, "lunora.config.ts"), `export default { app: (app) => app.auth({ namespace: (env) => env.AUTH, options: () => ({}) }) };\n`);

        expect(
            findDoAuthDeclaration(new Project({ skipAddingFilesFromTsConfig: true }), join(root, "lunora"))
                ?.getSourceFile()
                .getBaseName(),
        ).toBe("lunora.config.ts");
    });

    it("finds DO-backed auth, and fails toward it when the options cannot be read", () => {
        expect.assertions(4);

        expect(entryWithAuth(`{ d1: (env) => env.DB, options: () => ({}) }`)).toBeUndefined();
        expect(entryWithAuth(`{ "namespace": (env) => env.AUTH, options: () => ({}) }`)).toBeDefined();
        expect(entryWithAuth(`{ ...authConfig }`)).toBeDefined();
        expect(entryWithAuth(`authConfig`)).toBeDefined();
    });
});
