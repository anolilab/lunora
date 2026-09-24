import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverWorkerEntryCrons from "../../src/discover/worker-entry-crons";

let workdir: string;
let project: Project;

/** Write a project-relative source file — the worker entry lives outside `lunora/`. */
const writeAt = (relative: string, source: string): string => {
    const path = join(workdir, relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");

    return path;
};

const discover = (): string[] => discoverWorkerEntryCrons(project, join(workdir, "lunora"));

describe("discoverWorkerEntryCrons", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-entry-crons-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads a string-literal backupCron from the worker entry", () => {
        expect.assertions(1);

        writeAt("src/server/index.ts", `export default createWorker({ backupCron: "0 3 * * *", backupStore: env.BACKUPS });`);

        expect(discover()).toStrictEqual(["0 3 * * *"]);
    });

    it("reads the keys of a crons handler map, in source order after backupCron", () => {
        expect.assertions(1);

        writeAt(
            "src/server/index.ts",
            `export default createWorker({
                backupCron: "0 3 * * *",
                crons: { "*/15 * * * *": async () => {}, "0 0 1 * *": rollUp },
            });`,
        );

        expect(discover()).toStrictEqual(["0 3 * * *", "*/15 * * * *", "0 0 1 * *"]);
    });

    it("reads a backtick-quoted backupCron", () => {
        expect.assertions(1);

        // A `crons` KEY has no such form — a bare template literal is not a legal
        // property name — so backticks only ever reach the `backupCron` read.
        writeAt("src/index.ts", "export default createWorker({ backupCron: `0 3 * * *` });");

        expect(discover()).toStrictEqual(["0 3 * * *"]);
    });

    it("reads a shorthand-method crons key", () => {
        expect.assertions(1);

        writeAt("src/worker.ts", `export default createWorker({ crons: { "0 6 * * 1"() { return sweep(); } } });`);

        expect(discover()).toStrictEqual(["0 6 * * 1"]);
    });

    // The residue the `package.json` `lunora.crons` ownership record exists for:
    // `.extend(fn)` is a supported way to configure `backupCron`, so a computed
    // one is legitimate code no AST scan can resolve. It must read as
    // hand-written, not be invented as a literal.
    it.each([
        ["a computed backupCron", `export default createWorker({ backupCron: env.NIGHTLY_CRON });`],
        ["a template-substituted backupCron", `export default createWorker({ backupCron: \`0 \${hour} * * *\` });`],
        ["a computed crons key", `export default createWorker({ crons: { [env.SWEEP_CRON]: sweep } });`],
        ["an identifier crons key", `export default createWorker({ crons: { nightly: sweep } });`],
        ["a spread crons map", `export default createWorker({ crons: { ...baseCrons } });`],
        ["an opaque options object", `export default createWorker(options);`],
    ])("finds nothing in %s", (_label, source) => {
        expect.assertions(1);

        writeAt("src/server/index.ts", source);

        expect(discover()).toStrictEqual([]);
    });

    it("reads the object literal an .extend() callback returns, in both body forms", () => {
        expect.assertions(1);

        writeAt("src/server/index.ts", `export default app.extend(() => ({ backupCron: "0 4 * * *" })).build();`);
        writeAt(
            "src/server/nightly.ts",
            `export const withSweep = (builder) =>
                builder.extend((env) => {
                    return { crons: { "0 5 * * *": sweep } };
                });`,
        );

        // File order across the entry roots is not something this pins.
        expect(discover().toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["0 4 * * *", "0 5 * * *"]);
    });

    it("finds nothing in an .extend() callback whose body is not a literal", () => {
        expect.assertions(1);

        writeAt(
            "src/server/index.ts",
            `export default app.extend((env) => {
                const overrides = { backupCron: env.NIGHTLY_CRON };

                return overrides;
            }).build();`,
        );

        expect(discover()).toStrictEqual([]);
    });

    it("scans lunora/ too, so an entry helper kept there is not missed", () => {
        expect.assertions(1);

        writeAt("lunora/worker-options.ts", `export const options = createWorker({ backupCron: "0 2 * * *" });`);

        expect(discover()).toStrictEqual(["0 2 * * *"]);
    });

    it("ignores a createWorker call outside the entry roots", () => {
        expect.assertions(1);

        writeAt("src/components/Preview.ts", `export const fake = createWorker({ backupCron: "0 3 * * *" });`);

        expect(discover()).toStrictEqual([]);
    });

    it("deduplicates an expression declared twice", () => {
        expect.assertions(1);

        writeAt("src/server/index.ts", `export default createWorker({ backupCron: "0 3 * * *", crons: { "0 3 * * *": alsoAtThree } });`);

        expect(discover()).toStrictEqual(["0 3 * * *"]);
    });
});
