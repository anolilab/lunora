import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverContainerOverrides from "../src/discover-container-overrides";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverContainerOverrides", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-container-overrides-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a .start({ enableInternet: true }) launch override", () => {
        expect.assertions(2);

        write(
            "launch.ts",
            `export const boot = action(async ({ ctx }) => {
    const handle = ctx.containers.app.get("x");
    return handle.start({ enableInternet: true });
});`,
        );

        const found = discoverContainerOverrides(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ detail: "enableInternet: true", exportName: "boot", file: "launch", kind: "enable_internet", line: 3 });
    });

    it("does not flag a bare .start() or a .start({ cpu: 2 }) with no enableInternet", () => {
        expect.assertions(1);

        write(
            "bare.ts",
            `export const a = action(async ({ ctx }) => ctx.containers.app.get("x").start());
export const b = action(async ({ ctx }) => ctx.containers.app.get("x").start({ cpu: 2 }));`,
        );

        expect(discoverContainerOverrides(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags handle.egress.allow/deny/setAllowed as egress_relaxation", () => {
        expect.assertions(4);

        write(
            "egress.ts",
            `export const a = action(async ({ ctx }) => {
    const handle = ctx.containers.app.get("x");
    return handle.egress.allow("example.com");
});
export const b = action(async ({ ctx }) => {
    const handle = ctx.containers.app.get("x");
    return handle.egress.deny("example.com");
});
export const c = action(async ({ ctx }) => {
    const handle = ctx.containers.app.get("x");
    return handle.egress.setAllowed(["example.com"]);
});`,
        );

        const found = discoverContainerOverrides(project, join(workdir, "lunora"));

        expect(found).toHaveLength(3);
        expect(found[0]).toMatchObject({ detail: "allow", exportName: "a", kind: "egress_relaxation" });
        expect(found[1]).toMatchObject({ detail: "deny", exportName: "b", kind: "egress_relaxation" });
        expect(found[2]).toMatchObject({ detail: "setAllowed", exportName: "c", kind: "egress_relaxation" });
    });

    it("does not flag a non-mutating egress method", () => {
        expect.assertions(1);

        write(
            "list.ts",
            `export const a = action(async ({ ctx }) => {
    const handle = ctx.containers.app.get("x");
    return handle.egress.list();
});`,
        );

        expect(discoverContainerOverrides(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not flag a plain method call with an unrelated receiver", () => {
        expect.assertions(1);

        write("plain.ts", `export const a = action(async ({ ctx }) => ctx.db.query("users").collect());`);

        expect(discoverContainerOverrides(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
