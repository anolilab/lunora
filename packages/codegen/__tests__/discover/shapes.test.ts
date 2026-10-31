import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverShapes } from "../../src/discover/shapes";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeShapes = (source: string): void => {
    writeFileSync(join(workdir, "shapes.ts"), source);
};

describe("discover/shapes", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-shape-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/shapes.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverShapes(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineShape declarations into ShapeIR, sorted by export name", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape } from "@lunora/server";

            export const room = defineShape({ table: "messages", where: () => ({}) });
            export const channel = defineShape({ table: "messages", where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([
            { args: {}, exportName: "channel", filePath: "shapes", table: "messages" },
            { args: {}, exportName: "room", filePath: "shapes", table: "messages" },
        ]);
    });

    it("lifts the static `table` literal (and leaves it undefined when not a plain string)", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape } from "@lunora/server";

            const TABLE = "messages";
            export const literal = defineShape({ table: "messages", where: () => ({}) });
            export const dynamic = defineShape({ table: TABLE, where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([
            { args: {}, exportName: "dynamic", filePath: "shapes", table: undefined },
            { args: {}, exportName: "literal", filePath: "shapes", table: "messages" },
        ]);
    });

    it("lifts the `args` validator map so a collection's partition selector can be typed", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape, v } from "@lunora/server";

            export const channel = defineShape({
                args: { channelId: v.string(), since: v.optional(v.number()) },
                table: "messages",
                where: () => ({}),
            });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([
            {
                args: {
                    channelId: { kind: "string" },
                    since: { inner: { kind: "number" }, kind: "optional" },
                },
                exportName: "channel",
                filePath: "shapes",
                table: "messages",
            },
        ]);
    });

    it("resolves an aliased defineShape import from the umbrella subpath", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape as shape } from "lunorash/server";

            export const channel = shape({ table: "messages", where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([{ args: {}, exportName: "channel", filePath: "shapes", table: "messages" }]);
    });

    it("discovers a namespace-imported defineShape (server.defineShape)", () => {
        expect.assertions(1);

        writeShapes(`
            import * as server from "@lunora/server";

            export const channel = server.defineShape({ table: "messages", where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([{ args: {}, exportName: "channel", filePath: "shapes", table: "messages" }]);
    });

    it("ignores a namespace-imported defineShape from a foreign module", () => {
        expect.assertions(1);

        writeShapes(`
            import * as other from "other-pkg";

            export const channel = other.defineShape({ table: "messages", where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([]);
    });

    it("ignores a local defineShape not imported from @lunora/server", () => {
        expect.assertions(1);

        writeShapes(`
            const defineShape = (config: unknown) => config;

            export const channel = defineShape({ table: "messages", where: () => ({}) });
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([]);
    });

    it("ignores non-defineShape and unexported declarations", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape } from "@lunora/server";

            const internal = defineShape({ table: "messages", where: () => ({}) });
            export const notAShape = { table: "messages" };
        `);

        expect(discoverShapes(newProject(), workdir)).toEqual([]);
    });
    it("marks a shape whose where may read ctx.ip, directly or through a helper, and leaves others unmarked", () => {
        expect.assertions(1);

        writeShapes(`
            import { defineShape } from "@lunora/server";

            declare const helper: (ctx: unknown) => Record<string, unknown>;
            declare const byRef: any;

            export const aDirect = defineShape({ table: "messages", where: (ctx) => ({ ip: ctx.ip }) });
            export const bHelper = defineShape({ table: "messages", where: (ctx) => helper(ctx) });
            export const cByReference = defineShape({ table: "messages", where: byRef });
            export const dPlain = defineShape({ table: "messages", where: (ctx) => ({ owner: ctx.auth.userId }) });
            export const eUnused = defineShape({ table: "messages", where: (_context, { id }) => ({ id }) });
            export const fRenamed = defineShape({ table: "messages", where: (context) => ({ owner: context.auth.userId }) });
        `);

        const marked = discoverShapes(newProject(), workdir)
            .filter((shape) => shape.readsIp === true)
            .map((shape) => shape.exportName);

        expect(marked).toStrictEqual(["aDirect", "bHelper", "cByReference", "fRenamed"]);
    });
});
