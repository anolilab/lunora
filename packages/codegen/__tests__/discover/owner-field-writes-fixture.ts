import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { expect } from "vitest";

import { discoverMutators } from "../../src/discover/mutators";
import discoverOwnerFieldWrites from "../../src/discover/owner-field-writes";

type Row = ReturnType<typeof discoverOwnerFieldWrites>[number];

type FunctionList = Parameters<typeof discoverOwnerFieldWrites>[2];

/**
 * A `lunora/` workdir to create before and remove after each test, and
 * `discover`, which writes ONE fixture file there and discovers its owner-field
 * writes together with the mutators it declares. Wire `setUp` / `tearDown` into
 * `beforeEach` / `afterEach` of the `describe` that uses it.
 */
const createOwnerFieldFixture = (): {
    discover: (source: string, file?: string, project?: Project, functions?: FunctionList) => Row[];
    setUp: () => void;
    tearDown: () => void;
} => {
    let workdir = "";

    return {
        /** Pass `project` to reuse one across runs, as the Vite dev loop does. */
        discover: (
            source: string,
            file = "mutators.ts",
            project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }),
            functions: FunctionList = [],
        ): Row[] => {
            const lunoraDirectory = join(workdir, "lunora");

            writeFileSync(join(lunoraDirectory, file), source, "utf8");

            return discoverOwnerFieldWrites(project, lunoraDirectory, functions, discoverMutators(project, lunoraDirectory));
        },
        setUp: (): void => {
            workdir = mkdtempSync(join(tmpdir(), "lunora-owner-"));
            mkdirSync(join(workdir, "lunora"), { recursive: true });
        },
        tearDown: (): void => {
            rmSync(workdir, { force: true, recursive: true });
        },
    };
};

/** An exported owner-scoped mutator whose `server` impl takes `parameters` and runs `body`. */
const ownerMutator = (body: string, parameters = "ctx, args"): string =>
    `export const createPost = defineMutator({
    owner: "userId",
    server: async (${parameters}) => {
${body}
    },
});`;

/** A `ctx.db.insert` writing `value` into the owner column. */
const insert = (value: string): string => `ctx.db.insert("posts", { userId: ${value} })`;

const rowAt = (found: ReadonlyArray<Row>, line: number): Row | undefined => found.find((row) => row.line === line);

/** Recorded AND not owner-scoped, i.e. the lint reports it at full severity. */
const expectReported = (row: Row | undefined): void => {
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("ownerScoped");
};

export { createOwnerFieldFixture, expectReported, insert, ownerMutator, rowAt };
export type { Row };
