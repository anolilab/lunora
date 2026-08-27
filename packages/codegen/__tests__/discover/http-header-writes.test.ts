import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverHttpHeaderWrites from "../src/discover-http-header-writes";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

const discover = () => discoverHttpHeaderWrites(project, join(workdir, "lunora"));

describe("discoverHttpHeaderWrites", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-http-header-writes-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a request-header value reflected into a Response init header (via one const hop)", () => {
        expect.assertions(2);

        write(
            "echo.ts",
            `export const echo = httpAction(async (ctx, request) => {
                const host = request.headers.get("x-forwarded-host") ?? "";
                return new Response("ok", { headers: { "x-host": host } });
            });`,
        );

        const found = discover();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "echo", headerName: "x-host", via: "response-init" });
    });

    it("records a URL/query value set via headers.set on a Headers instance", () => {
        expect.assertions(2);

        write(
            "redirect.ts",
            `export const go = httpAction(async (ctx, request) => {
                const h = new Headers();
                h.set("location", new URL(request.url).searchParams.get("next") ?? "/");
                return new Response(null, { status: 302, headers: h });
            });`,
        );

        const found = discover();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "go", headerName: "location", via: "headers-set" });
    });

    it("records a request-body field reflected into a Response.json header", () => {
        expect.assertions(2);

        write(
            "tag.ts",
            `export const tag = httpAction(async (ctx, request) => {
                const body = await request.json();
                return Response.json({ ok: true }, { headers: { "x-echo": body.tag } });
            });`,
        );

        const found = discover();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "tag", headerName: "x-echo", via: "response-init" });
    });

    it("records a request value in a concise-body arrow (new Response as the arrow body)", () => {
        expect.assertions(1);

        write("concise.ts", `export const c = httpAction((ctx, request) => new Response("ok", { headers: { "x-ua": request.headers.get("user-agent") } }));`);

        expect(discover()).toHaveLength(1);
    });

    it("records a value set via new Headers({...}) initializer and headers.append", () => {
        expect.assertions(2);

        write(
            "ctor.ts",
            `export const a = httpAction((ctx, request) => new Response("ok", { headers: new Headers({ "x-ref": request.headers.get("referer") }) }));
             export const b = httpAction(async (ctx, request) => {
                const res = new Response("ok");
                res.headers.append("x-lang", request.headers.get("accept-language"));
                return res;
             });`,
        );

        const found = discover();

        expect(found.map((row) => row.via).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["headers-append", "headers-ctor"]);
        expect(found).toHaveLength(2);
    });

    it("does not record a value routed through isSafeHeaderValue guard", () => {
        expect.assertions(1);

        write(
            "guarded.ts",
            `export const g = httpAction((ctx, request) => {
                const raw = request.headers.get("x-tenant");
                return new Response("ok", { headers: { "x-tenant": isSafeHeaderValue(raw) ? raw : "default" } });
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a value routed through encodeURIComponent", () => {
        expect.assertions(1);

        write(
            "encoded.ts",
            `export const e = httpAction((ctx, request) => new Response("ok", { headers: { "x-q": encodeURIComponent(request.headers.get("x-q")) } }));`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a numeric coercion (Number strips CR/LF)", () => {
        expect.assertions(1);

        write(
            "numeric.ts",
            `export const n = httpAction((ctx, request) => new Response("ok", { headers: { "x-count": String(Number(request.headers.get("x-count"))) } }));`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record a header value that never touches request input", () => {
        expect.assertions(1);

        write(
            "static.ts",
            `export const s = httpAction((ctx, request) => new Response("ok", { headers: { "cache-control": "no-store", "x-app": "lunora" } }));`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("does not record forwarding a request header to an outbound fetch (not a response header)", () => {
        expect.assertions(1);

        write(
            "forward.ts",
            `export const f = httpAction(async (ctx, request) => {
                await fetch("https://upstream.example", { headers: { authorization: request.headers.get("authorization") } });
                return new Response("ok");
            });`,
        );

        expect(discover()).toHaveLength(0);
    });

    it("skips an httpAction whose request parameter is destructured (unresolvable — fail-safe)", () => {
        expect.assertions(1);

        write("destructured.ts", `export const d = httpAction((ctx, { headers }) => new Response("ok", { headers: { "x-h": headers.get("x-h") } }));`);

        expect(discover()).toHaveLength(0);
    });
});
