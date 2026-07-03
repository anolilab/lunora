import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFlagSecurityDefaults from "../src/discover-flag-security-defaults";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

// eslint-disable-next-line no-secrets/no-secrets -- test suite name (a long camelCase identifier), not a credential
describe("discoverFlagSecurityDefaults", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-flag-security-defaults-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a ctx.flags.boolean read with its literal key and boolean default", () => {
        expect.assertions(2);

        write("gate.ts", `export const list = query(async ({ ctx }) => ctx.flags.boolean("enforceRls", false));`);

        const found = discoverFlagSecurityDefaults(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ defaultValue: false, exportName: "list", key: "enforceRls" });
    });

    it("captures a true default", () => {
        expect.assertions(1);

        write("bypass.ts", `export const run = query(async ({ ctx }) => ctx.flags.boolean("bypassAuth", true));`);

        const [row] = discoverFlagSecurityDefaults(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ defaultValue: true, key: "bypassAuth" });
    });

    it("does not record ctx.flags.details.boolean (a different return shape)", () => {
        expect.assertions(1);

        write("details.ts", `export const run = query(async ({ ctx }) => ctx.flags.details.boolean("enforceRls", false));`);

        expect(discoverFlagSecurityDefaults(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not record a non-boolean typed flag read", () => {
        expect.assertions(1);

        write("num.ts", `export const run = query(async ({ ctx }) => ctx.flags.number("limit", 10));`);

        expect(discoverFlagSecurityDefaults(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips a read whose default is not a boolean literal", () => {
        expect.assertions(1);

        write("dynamic.ts", `export const run = query(async ({ ctx }) => ctx.flags.boolean("enforceRls", fallback));`);

        expect(discoverFlagSecurityDefaults(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips a read whose key is not a string literal", () => {
        expect.assertions(1);

        write("computed.ts", `export const run = query(async ({ ctx }) => ctx.flags.boolean(keyVar, false));`);

        expect(discoverFlagSecurityDefaults(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
