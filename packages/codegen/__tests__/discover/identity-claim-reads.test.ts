import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverIdentityClaimReads from "../src/discover-identity-claim-reads";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const CONTRACT = `import { defineIdentity, v } from "@lunora/server";
export const identity = defineIdentity({ userId: v.string(), tenantId: v.optional(v.string()) });
`;

describe("discoverIdentityClaimReads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-identity-claims-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("tags a declared claim read as declared", () => {
        expect.assertions(2);

        write("identity.ts", CONTRACT);
        write("policy.ts", `export const p = definePolicy({ when: ({ auth }) => auth.identity.tenantId === "x" });`);

        const rows = discoverIdentityClaimReads(project, join(workdir, "lunora"));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ declared: true, key: "tenantId" });
    });

    it("tags an undeclared claim read as not declared", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("policy.ts", `export const p = definePolicy({ when: ({ auth }) => auth.identity.role === "admin" });`);

        const [row] = discoverIdentityClaimReads(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ declared: false, exportName: "p", key: "role" });
    });

    it("treats the always-present userId as declared even if not in the map body", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("policy.ts", `export const p = definePolicy({ when: ({ ctx }) => ctx.auth.identity.userId === row.owner });`);

        const [row] = discoverIdentityClaimReads(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ declared: true, key: "userId" });
    });

    it("reads a bracket-access claim key", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("policy.ts", `export const p = definePolicy({ when: ({ auth }) => auth.identity["role"] === "admin" });`);

        const [row] = discoverIdentityClaimReads(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ declared: false, key: "role" });
    });

    it("returns nothing when no defineIdentity contract exists", () => {
        expect.assertions(1);

        write("policy.ts", `export const p = definePolicy({ when: ({ auth }) => auth.identity.role === "admin" });`);

        expect(discoverIdentityClaimReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("returns nothing when the contract's claim map is opaque (a spread)", () => {
        expect.assertions(1);

        write("identity.ts", `export const identity = defineIdentity({ ...base, userId: v.string() });`);
        write("policy.ts", `export const p = definePolicy({ when: ({ auth }) => auth.identity.role === "admin" });`);

        expect(discoverIdentityClaimReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not treat an unrelated .identity receiver as an identity bag", () => {
        expect.assertions(1);

        write("identity.ts", CONTRACT);
        write("other.ts", `export const p = definePolicy({ when: () => provider.identity.role === "admin" });`);

        expect(discoverIdentityClaimReads(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
