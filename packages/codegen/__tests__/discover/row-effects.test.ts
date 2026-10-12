import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRowEffects from "../../src/discover/row-effects";
import discoverTableWrites from "../../src/discover/table-writes";

let workdir: string;
let lunora: string;

/** The helper deletes through the table facade, so its table is readable without the id's type. */
const PURGE = `export const purge = async (ctx: { db: { sessions: { delete: (id: string) => Promise<void> } } }, id: string): Promise<void> => {
    await ctx.db.sessions.delete(id);
};
`;

/** The sweep reads the open range, and deletes through the helper in another file. */
const SWEEP = `import { purge } from "./lib/purge";

export const expire = async ({ ctx }: { ctx: { db: { query: (table: string) => unknown } } }): Promise<void> => {
    const rows = (await ctx.db.query("sessions")) as { _id: string }[];
    for (const row of rows) {
        await purge({ db: { sessions: { delete: async () => undefined } } } as never, row._id);
    }
};

export const reportOnly = async ({ ctx }: { ctx: { db: { query: (table: string) => unknown } } }): Promise<void> => {
    await ctx.db.query("sessions");
};
`;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "lunora-row-effects-"));
    lunora = join(workdir, "lunora");
    mkdirSync(join(lunora, "lib"), { recursive: true });
    writeFileSync(join(lunora, "lib", "purge.ts"), PURGE, "utf8");
    writeFileSync(join(lunora, "sweep.ts"), SWEEP, "utf8");
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("discoverRowEffects", () => {
    it("attributes a helper's delete in another file to the export that calls it", () => {
        expect.assertions(1);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const effects = discoverRowEffects(project, lunora, discoverTableWrites(project, lunora), []);

        // `purge` is exported too, so it reports its own delete; the sweep's effect is the one that reaches it through the import.
        expect(effects.filter((effect) => effect.file === "sweep")).toStrictEqual([
            expect.objectContaining({ exportName: "expire", file: "sweep", method: "delete", table: "sessions" }),
        ]);
    });

    it("reports nothing for an export that reaches no row-changing write", () => {
        expect.assertions(1);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const effects = discoverRowEffects(project, lunora, discoverTableWrites(project, lunora), []);

        expect(effects.some((effect) => effect.exportName === "reportOnly")).toBe(false);
    });
});

describe("discoverTableWrites fields", () => {
    it("records the keys of a patch's object literal, and leaves them undefined for other writes", () => {
        expect.assertions(2);

        writeFileSync(
            join(lunora, "patches.ts"),
            `export const edit = async (ctx: { db: { sessions: { patch: (id: string, value: object) => Promise<void>; delete: (id: string) => Promise<void> } } }): Promise<void> => {
    await ctx.db.sessions.patch("a", { expiresAt: 1, title: "x" });
    await ctx.db.sessions.delete("a");
};
`,
            "utf8",
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const writes = discoverTableWrites(project, lunora).filter((write) => write.file === "patches");

        expect(writes.find((write) => write.method === "patch")?.fields).toStrictEqual(["expiresAt", "title"]);
        expect(writes.find((write) => write.method === "delete")?.fields).toBeUndefined();
    });
});
