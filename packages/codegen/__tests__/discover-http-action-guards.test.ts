import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverHttpActionGuards from "../src/discover-http-action-guards";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverHttpActionGuards", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-http-action-guards-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records an httpAction that runs a mutation without reading ctx.auth", () => {
        expect.assertions(3);

        write(
            "hook.ts",
            `export const webhook = httpAction(async (ctx, request) => { await ctx.runMutation(api.messages.add, {}); return new Response("ok"); });`,
        );

        const found = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "webhook", kind: "httpAction", readsAuth: false, sideEffect: "runMutation" });
        expect(found[0]?.method).toBeUndefined();
    });

    it("marks readsAuth true when the handler reads ctx.auth directly", () => {
        expect.assertions(1);

        write(
            "guarded.ts",
            `export const webhook = httpAction(async (ctx, request) => {
                const identity = await ctx.auth.getIdentity();
                if (!identity) return new Response("no", { status: 401 });
                await ctx.runMutation(api.messages.add, {});
                return new Response("ok");
            });`,
        );

        const [row] = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ readsAuth: true, sideEffect: "runMutation" });
    });

    it("marks readsAuth true when the handler destructures auth off ctx", () => {
        expect.assertions(1);

        write(
            "destructured.ts",
            `export const webhook = httpAction(async (ctx, request) => {
                const { auth } = ctx;
                await auth.getIdentity();
                await ctx.runAction(api.jobs.sync, {});
                return new Response("ok");
            });`,
        );

        const [row] = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ readsAuth: true, sideEffect: "runAction" });
    });

    it("does not record a read-only httpAction (ctx.runQuery only)", () => {
        expect.assertions(1);

        write(
            "read.ts",
            `export const feed = httpAction(async (ctx, request) => { const rows = await ctx.runQuery(api.messages.list, {}); return Response.json(rows); });`,
        );

        expect(discoverHttpActionGuards(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("records a ctx.db write as the side effect", () => {
        expect.assertions(1);

        write(
            "dbwrite.ts",
            `export const ingest = httpAction(async (ctx, request) => { await ctx.db.insert("events", { at: Date.now() }); return new Response("ok"); });`,
        );

        const [row] = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ readsAuth: false, sideEffect: "db.insert" });
    });

    it("records a typed httpRoute handler with its verb and destructured ctx", () => {
        expect.assertions(2);

        write(
            "route.ts",
            `export const submit = httpRoute
                .post("/submit")
                .body({ text: v.string() })
                .handler(async ({ ctx, body }) => { await ctx.runMutation(api.messages.add, body); return Response.json({ ok: true }); });`,
        );

        const found = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "submit", kind: "httpRoute", method: "POST", readsAuth: false, sideEffect: "runMutation" });
    });

    it("detects the side effect of a concise-body arrow handler (call as the body)", () => {
        expect.assertions(2);

        // Concise body — the `ctx.runMutation(...)` call IS the arrow body, which
        // `getDescendantsOfKind` skips; without inspecting the body node itself the
        // side effect is missed and the missing-guard finding never fires.
        write("concise.ts", `export const submit = httpRoute.post("/submit").handler(({ ctx, body }) => ctx.runMutation(api.messages.add, body));`);

        const found = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "submit", kind: "httpRoute", method: "POST", readsAuth: false, sideEffect: "runMutation" });
    });

    it("respects a ctx alias in a httpRoute destructure for both side-effect and auth detection", () => {
        expect.assertions(1);

        write(
            "aliased.ts",
            `export const submit = httpRoute
                .put("/submit")
                .handler(async ({ ctx: c }) => { await c.auth.getIdentity(); await c.runMutation(api.messages.add, {}); return new Response("ok"); });`,
        );

        const [row] = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ kind: "httpRoute", method: "PUT", readsAuth: true, sideEffect: "runMutation" });
    });

    it("falls back to <module> for an inline-mounted httpAction with no binding name", () => {
        expect.assertions(1);

        write("mount.ts", `app.post("/hook", httpAction(async (ctx, request) => { await ctx.runAction(api.jobs.sync, {}); return new Response("ok"); }));`);

        const [row] = discoverHttpActionGuards(project, join(workdir, "lunora"));

        expect(row).toMatchObject({ exportName: "<module>", kind: "httpAction", readsAuth: false });
    });

    it("skips a named-function or wrapped handler (unresolvable body — fail-safe)", () => {
        expect.assertions(1);

        write(
            "opaque.ts",
            `export const named = httpAction(handleWebhook);
             export const wrapped = httpAction(withLogging(async (ctx) => { await ctx.runMutation(api.messages.add, {}); }));`,
        );

        expect(discoverHttpActionGuards(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("skips an httpAction whose ctx parameter is destructured (unresolvable ctx binding — fail-safe)", () => {
        expect.assertions(1);

        write(
            "destructured-ctx.ts",
            `export const webhook = httpAction(async ({ runMutation }, request) => { await runMutation(api.messages.add, {}); return new Response("ok"); });`,
        );

        expect(discoverHttpActionGuards(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
