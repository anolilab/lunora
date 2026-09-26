import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertJurisdictionMoveAcknowledged, findDoAuthDeclaration } from "../../src/discover/jurisdiction-move";
import discoverSchema from "../../src/discover/schema";
import type { AgentIR, SchemaIR } from "../../src/ir";

/**
 * Upgrading an app that already declares `.jurisdiction()` changes nothing in
 * its schema, so no drift gate fires — yet voice sessions and DO-backed auth,
 * which were never pinned, would now resolve to new, empty objects: every user
 * locked out, every transcript gone. Codegen must refuse that until the schema
 * acknowledges the move.
 */
describe("jurisdiction move of auth and voice", () => {
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

    const voiceAgent = { exportName: "support", voice: true } as unknown as AgentIR;

    it("reads the acknowledgement off the schema chain", () => {
        expect.assertions(3);

        expect(schemaWith(`.jurisdiction("eu")`).jurisdictionPinsAuthAndVoice).toBeUndefined();
        expect(schemaWith(`.jurisdiction("eu", { pinAuthAndVoice: true })`).jurisdictionPinsAuthAndVoice).toBe(true);
        expect(schemaWith(`.jurisdiction("eu", { pinAuthAndVoice: false })`).jurisdictionPinsAuthAndVoice).toBeUndefined();
    });

    it("refuses DO-backed auth under an unacknowledged jurisdiction, at the .auth() call", () => {
        expect.assertions(1);

        const declaration = entryWithAuth(`{ namespace: (env) => env.AUTH, options: () => ({}) }`);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), [], declaration);
        }).toThrow(/DO-backed auth[\s\S]*NEW, EMPTY objects[\s\S]*pinAuthAndVoice: true[\s\S]*src\/index\.ts:2/u);
    });

    it("refuses voice sessions under an unacknowledged jurisdiction", () => {
        expect.assertions(1);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), [voiceAgent], undefined);
        }).toThrow(/voice sessions of agent\(s\) "support"/u);
    });

    it("accepts both once acknowledged, and projects that have neither", () => {
        expect.assertions(3);

        const declaration = entryWithAuth(`{ namespace: (env) => env.AUTH, options: () => ({}) }`);

        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu", { pinAuthAndVoice: true })`), [voiceAgent], declaration);
        }).not.toThrow();
        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(`.jurisdiction("eu")`), [], undefined);
        }).not.toThrow();
        expect(() => {
            assertJurisdictionMoveAcknowledged(schemaWith(""), [voiceAgent], declaration);
        }).not.toThrow();
    });

    it("finds DO-backed auth, and fails toward it when the options cannot be read", () => {
        expect.assertions(4);

        expect(entryWithAuth(`{ d1: (env) => env.DB, options: () => ({}) }`)).toBeUndefined();
        expect(entryWithAuth(`{ "namespace": (env) => env.AUTH, options: () => ({}) }`)).toBeDefined();
        expect(entryWithAuth(`{ ...authConfig }`)).toBeDefined();
        expect(entryWithAuth(`authConfig`)).toBeDefined();
    });
});
