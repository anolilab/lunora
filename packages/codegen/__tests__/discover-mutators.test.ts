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
            { exportName: "editMessage", filePath: "mutators" },
            { exportName: "sendMessage", filePath: "mutators" },
        ]);
    });

    it("resolves an aliased defineMutator import from the umbrella subpath", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator as mut } from "lunorash/server";

            export const sendMessage = mut({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ exportName: "sendMessage", filePath: "mutators" }]);
    });

    it("discovers a namespace-imported defineMutator (server.defineMutator)", () => {
        expect.assertions(1);

        writeMutators(`
            import * as server from "@lunora/server";

            export const sendMessage = server.defineMutator({ server: async () => {} });
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ exportName: "sendMessage", filePath: "mutators" }]);
    });

    it("discovers a mutator exported via a separate export statement", () => {
        expect.assertions(1);

        writeMutators(`
            import { defineMutator } from "@lunora/server";

            const sendMessage = defineMutator({ server: async () => {} });
            export { sendMessage };
        `);

        expect(discoverMutators(newProject(), workdir)).toEqual([{ exportName: "sendMessage", filePath: "mutators" }]);
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
