import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverContainers } from "../../src/discover/containers";
import discoverCrons from "../../src/discover/crons";
import discoverSchema from "../../src/discover/schema";
import { parseObjectShape } from "../../src/parse-validator";

/**
 * A quoted object key (`{ "name": … }`) is the same key to the runtime as a bare
 * one. ts-morph's `getName()` returns the key's source text, quotes included, so
 * every reader that took it verbatim treated the two as different keys.
 */
describe("quoted object keys read as their runtime key", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-quoted-keys-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const write = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true });

    it("dispatches a cron with the declared argument names", () => {
        expect.assertions(1);

        write(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, { "batch": 10, 'mode': "full", plain: true });
            export default crons;
        `,
        );

        expect(discoverCrons(newProject(), workdir)).toStrictEqual([
            { args: { batch: 10, mode: "full", plain: true }, cron: "0 9 * * *", functionPath: "email:digest", name: "digest" },
        ]);
    });

    it("reads a numeric key as the runtime's canonical string of its value", () => {
        expect.assertions(1);

        // `{ 0x10: … }` is the key "16" at runtime, `{ 1e3: … }` is "1000", and
        // `{ 1.50: … }` is "1.5". TypeScript's scanner already normalises a
        // numeric literal's text to that value, which `propertyNameText` reads
        // through `getLiteralText()` — this pins it.
        write(
            "crons.ts",
            `
            import { cronJobs } from "@lunora/scheduler";
            import { internal } from "./_generated/api.js";
            const crons = cronJobs();
            crons.daily("digest", { hourUTC: 9, minuteUTC: 0 }, internal.email.digest, { 0x10: "hex", 1e3: "exp", 1_000_000: "sep", 0b11: "bin", 1.50: "frac", 7: "plain" });
            export default crons;
        `,
        );

        expect(Object.keys(discoverCrons(newProject(), workdir)[0]?.args ?? {})).toStrictEqual(["3", "7", "16", "1000", "1000000", "1.5"]);
    });

    it("reads quoted schema table and field names", () => {
        expect.assertions(2);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
        const schemaPath = "/virtual/lunora/schema.ts";

        project.createSourceFile(
            schemaPath,
            `
            import { defineSchema, defineTable, v } from "@lunora/server";

            export default defineSchema({
                "notes": defineTable({ "title": v.string(), body: v.string() }),
            });
        `,
        );

        const [table] = discoverSchema(project, schemaPath).tables;

        expect(table?.name).toBe("notes");
        expect(Object.keys(table?.shape ?? {})).toStrictEqual(["title", "body"]);
    });

    it("reads quoted `.input()` / object-shape keys", () => {
        expect.assertions(1);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
        const source = project.createSourceFile("/virtual/shape.ts", `const shape = { "email": v.string(), 'count': v.number() };`);
        const literal = source.getVariableDeclarationOrThrow("shape").getInitializerOrThrow();

        expect(parseObjectShape(literal as Parameters<typeof parseObjectShape>[0])).toStrictEqual({ count: { kind: "number" }, email: { kind: "string" } });
    });

    it("reads quoted container build args and wrangler settings", () => {
        expect.assertions(1);

        write(
            "containers.ts",
            `
            import { defineContainer } from "@lunora/container";
            export const a = defineContainer({ image: "./c/a", "buildArgs": { "NODE_VERSION": "22", PLAIN: "x" }, "maxInstances": 3, "enableInternet": false });
        `,
        );

        const [container] = discoverContainers(newProject(), workdir);

        expect({ buildArgs: container?.buildArgs, enableInternet: container?.enableInternet, maxInstances: container?.maxInstances }).toStrictEqual({
            buildArgs: { NODE_VERSION: "22", PLAIN: "x" },
            enableInternet: false,
            maxInstances: 3,
        });
    });
});
