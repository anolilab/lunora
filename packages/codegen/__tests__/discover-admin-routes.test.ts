import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAdminRoutes from "../src/discover-admin-routes";

/** An `/admin/*` route whose handler shows no auth/admin guard. */
const UNGUARDED = `
    declare const httpRoute: any;

    export const purge = httpRoute.post("/admin/purge").handler(async (ctx) => {
        return new Response("ok");
    });
`;

/** An `/admin/*` route that checks a session before doing work. */
const GUARDED = `
    declare const httpRoute: any;
    declare const getSession: (ctx: unknown) => Promise<unknown>;

    export const stats = httpRoute.get("/admin/stats").handler(async (ctx) => {
        const session = await getSession(ctx);
        return new Response(JSON.stringify(session));
    });
`;

/** A non-admin route — not on a privileged path, so never recorded. */
const PUBLIC = `
    declare const httpRoute: any;

    export const health = httpRoute.get("/health").handler(() => new Response("ok"));
`;

let workdir: string;
let project: Project;

describe("discoverAdminRoutes", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-admin-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records an unguarded admin route", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "purge.ts"), UNGUARDED, "utf8");

        const found = discoverAdminRoutes(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "purge", method: "POST", path: "/admin/purge", usesGuard: false });
    });

    it("marks an admin route that references a guard as guarded", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "stats.ts"), GUARDED, "utf8");

        const found = discoverAdminRoutes(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "stats", usesGuard: true });
    });

    it("ignores routes that are not on an admin/privileged path", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "health.ts"), PUBLIC, "utf8");

        expect(discoverAdminRoutes(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
