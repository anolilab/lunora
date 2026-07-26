import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMutators } from "../src/discover-mutators";

let workdir: string;

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

const writeMutators = (source: string): void => {
    writeFileSync(join(workdir, "mutators.ts"), source);
};

describe("discover-mutators", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mutator-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("returns [] when lunora/mutators.ts does not exist", () => {
        expect.assertions(1);

        expect(discoverMutators(newProject(), workdir)).toEqual([]);
    });

    it("lifts exported defineMutator declarations into MutatorIR, sorted by export name", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator } from "@lunora/server";

            export const sendMessage = defineMutator({ server: async () => {} });
            export const editMessage = defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([
            { args: {}, exportName: "editMessage", filePath: "mutators", returnType: "void" },
            { args: {}, exportName: "sendMessage", filePath: "mutators", returnType: "void" },
        ]);
    });

    it("resolves an aliased defineMutator import from the umbrella subpath", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator as mut } from "lunorash/server";

            export const sendMessage = mut({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ args: {}, exportName: "sendMessage", filePath: "mutators", returnType: "void" }]);
    });

    it("discovers a namespace-imported defineMutator (server.defineMutator)", () => {
        expect.assertions(1);

        writeMutators(`
            import * as server from "@lunora/server";

            export const sendMessage = server.defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ args: {}, exportName: "sendMessage", filePath: "mutators", returnType: "void" }]);
    });

    it("discovers a mutator exported via a separate export statement", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator } from "@lunora/server";

            const sendMessage = defineMutator({ server: async () => {} });
            export { sendMessage };
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ args: {}, exportName: "sendMessage", filePath: "mutators", returnType: "void" }]);
    });

    it("discovers a defineMutator imported from the generated _generated/server re-export", () => {
        expect.assertions(1);

        // The project-typed form: `_generated/server.ts` re-exports `defineMutator`
        // bound to this schema's `MutationCtx`, so the authoritative `server` impl
        // gets a typed `ctx.db`. Discovery must treat it as a real declaration —
        // otherwise the typed authoring path silently registers nothing.
        writeMutators(`
            import { defineMutator } from "./_generated/server";

            export const sendMessage = defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ args: {}, exportName: "sendMessage", filePath: "mutators", returnType: "void" }]);
    });

    it("lifts the args validator map and the server impl's return type", () => {
        expect.assertions(1);

        // Feeds the emitted `api.mutators.<name>` reference: the args type a client
        // `defineMutator({ serverRef: api.mutators.send })` infers, and the return
        // type `ctx.runMutation(api.mutators.send, …)` resolves.
        writeMutators(`
            import { defineMutator, v } from "@lunora/server";

            export const send = defineMutator({
                args: { channelId: v.string(), text: v.string(), pinned: v.optional(v.boolean()) },
                server: async () => ({ ok: true }),
            });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([
            {
                args: {
                    channelId: { kind: "string" },
                    pinned: { inner: { kind: "boolean" }, kind: "optional" },
                    text: { kind: "string" },
                },
                exportName: "send",
                filePath: "mutators",
                returnType: "{ ok: boolean; }",
            },
        ]);
    });

    it("ignores a namespace-imported defineMutator from a foreign module", () => {
        expect.assertions(1);

        writeMutators(`
            import * as other from "other-pkg";

            export const sendMessage = other.defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([]);
    });

    it("ignores a local defineMutator not imported from @lunora/server", () => {
        expect.assertions(1);

        writeMutators(`
            const defineMutator = (config: unknown) => config;

            export const sendMessage = defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([]);
    });

    it("ignores non-defineMutator and unexported declarations", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator } from "@lunora/server";

            const internal = defineMutator({ server: async () => {} });
            export const notAMutator = { server: async () => {} };
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([]);
    });
});
