import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAuthApiCalls from "../src/discover-authapi-calls";

/** An httpAction-like exported function calling ctx.authApi.banUser with headers. */
const WITH_HEADERS = `
    import { httpAction } from "@lunora/server";

    export const a = httpAction(async (ctx, request) => {
        await ctx.authApi.banUser({ body: {}, headers: request.headers });
    });
`;

/** An httpAction-like exported function calling ctx.authApi.banUser WITHOUT headers. */
const WITHOUT_HEADERS = `
    import { httpAction } from "@lunora/server";

    export const b = httpAction(async (ctx) => {
        await ctx.authApi.banUser({ body: {} });
    });
`;

/** Destructured authApi call — bare authApi.setRole without headers. */
const DESTRUCTURED = `
    import { httpAction } from "@lunora/server";

    export const c = httpAction(async (ctx) => {
        const { authApi } = ctx;
        await authApi.setRole({ body: {} });
    });
`;

/** Not exported — should be dropped. */
const NOT_EXPORTED = `
    import { httpAction } from "@lunora/server";

    const helper = async (ctx) => {
        await ctx.authApi.banUser({ body: {} });
    };
`;

/** Non-literal (variable) argument — hasHeaders should be true (conservative). */
const VARIABLE_ARG = `
    import { httpAction } from "@lunora/server";

    export const d = httpAction(async (ctx, request) => {
        const opts = { body: {}, headers: request.headers };
        await ctx.authApi.banUser(opts);
    });
`;

let workdir: string;
let project: Project;

describe("discoverAuthApiCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-authapi-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("discovers a call with headers and marks hasHeaders: true", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "with-headers.ts"), WITH_HEADERS, "utf8");

        const calls = discoverAuthApiCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exportName: "a", file: "with-headers", hasHeaders: true, method: "banUser" });
    });

    it("discovers a call without headers and marks hasHeaders: false", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "without-headers.ts"), WITHOUT_HEADERS, "utf8");

        const calls = discoverAuthApiCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exportName: "b", file: "without-headers", hasHeaders: false, method: "banUser" });
    });

    it("discovers a destructured authApi call without headers and marks hasHeaders: false", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "destructured.ts"), DESTRUCTURED, "utf8");

        const calls = discoverAuthApiCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exportName: "c", file: "destructured", hasHeaders: false, method: "setRole" });
    });

    it("drops calls that are not inside an exported declaration", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "not-exported.ts"), NOT_EXPORTED, "utf8");

        const calls = discoverAuthApiCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(0);
    });

    it("treats a non-literal argument (variable) as hasHeaders: true (conservative)", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "variable-arg.ts"), VARIABLE_ARG, "utf8");

        const calls = discoverAuthApiCalls(project, join(workdir, "lunora"));

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ exportName: "d", hasHeaders: true, method: "banUser" });
    });
});
