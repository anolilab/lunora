import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFailOpenGuards from "../src/discover-fail-open-guards";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverFailOpenGuards", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-fail-open-guards-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a rateLimit guard with failOpen:true and its limit name (options at arg index 2)", () => {
        expect.assertions(2);

        write("signin.ts", `export const signIn = mutation.use(rateLimit(limiter, "signin", { failOpen: true })).mutation(async () => {});`);

        const found = discoverFailOpenGuards(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ callee: "rateLimit", exportName: "signIn", failOpen: true, limitName: "signin" });
    });

    it("records a dbRateLimit guard's failOpen from the third argument", () => {
        expect.assertions(1);

        write(
            "send.ts",
            `export const send = mutation.use(dbRateLimit(limits, "send", { failOpen: true, key: (ctx) => ctx.auth.userId })).mutation(async () => {});`,
        );

        const [row] = discoverFailOpenGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ callee: "dbRateLimit", exportName: "send", failOpen: true, limitName: "send" });
    });

    it("records a verifyTurnstileMiddleware guard's failOpen from the first argument, with an empty limitName", () => {
        expect.assertions(1);

        write("register.ts", `export const register = mutation.use(verifyTurnstileMiddleware({ failOpen: true })).mutation(async () => {});`);

        const [row] = discoverFailOpenGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ callee: "verifyTurnstileMiddleware", exportName: "register", failOpen: true, limitName: "" });
    });

    it("records failOpen:false when the option is absent (a bare fail-closed guard)", () => {
        expect.assertions(1);

        write("closed.ts", `export const signIn = mutation.use(rateLimit(limiter, "signin")).mutation(async () => {});`);

        const [row] = discoverFailOpenGuards(project, join(workdir, "lunora"));

        expect(row?.failOpen).toBe(false);
    });

    it("treats a non-literal failOpen initializer as fail-closed", () => {
        expect.assertions(1);

        write("dynamic.ts", `export const signIn = mutation.use(rateLimit(limiter, "signin", { failOpen: cfg.degrade })).mutation(async () => {});`);

        const [row] = discoverFailOpenGuards(project, join(workdir, "lunora"));

        expect(row?.failOpen).toBe(false);
    });

    it("does not record an unrelated call with a failOpen option", () => {
        expect.assertions(1);

        write("unrelated.ts", `export const x = someOtherMiddleware({ failOpen: true });`);

        expect(discoverFailOpenGuards(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
