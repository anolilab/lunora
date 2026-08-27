import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverHttpRoutes from "../src/discover-http-routes";

let workdir: string;

describe("discover-http-routes", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-http-disco-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeSource = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

    it("lifts a `.handler()` route with searchParams into HttpRouteIR (stream: false, no chunkType)", () => {
        expect.assertions(1);

        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";
            import { v } from "./_generated/server.js";

            export const listTodos = httpRoute
                .get("/api/todos")
                .searchParams({ limit: v.number() })
                .handler(async () => []);
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes).toStrictEqual([
            {
                body: {},
                exportName: "listTodos",
                filePath: "http",
                method: "GET",
                params: {},
                path: "/api/todos",
                searchParams: { limit: { kind: "number" } },
                stream: false,
            },
        ]);
    });

    it("captures the yielded chunk type of a `.stream()` terminal", () => {
        expect.assertions(3);

        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";

            export const streamTokens = httpRoute.get("/api/tokens").stream(async function* () {
                yield { text: "hello" };
                yield { text: "world" };
            });
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes).toHaveLength(1);
        expect(routes[0]?.stream).toBe(true);
        expect(routes[0]?.chunkType).toBe("{ text: string; }");
    });

    it("captures the chunk type of an arrow handler returning an AsyncIterable", () => {
        expect.assertions(2);

        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";

            const iterate = async function* (): AsyncGenerator<number, void, void> {
                yield 1;
            };

            export const streamNumbers = httpRoute.get("/api/numbers").stream(() => iterate());
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes[0]?.stream).toBe(true);
        expect(routes[0]?.chunkType).toBe("number");
    });

    it("falls back to `unknown` when the stream handler is a hoisted identifier", () => {
        expect.assertions(2);

        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";

            async function* pump() {
                yield 1;
            }

            export const streamNumbers = httpRoute.get("/api/numbers").stream(pump);
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes[0]?.stream).toBe(true);
        expect(routes[0]?.chunkType).toBe("unknown");
    });

    it("walks searchParams and path params through a stream chain", () => {
        expect.assertions(1);

        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";
            import { v } from "./_generated/server.js";

            export const streamRoom = httpRoute
                .get("/api/rooms/:roomId/events")
                .params({ roomId: v.string() })
                .searchParams({ since: v.optional(v.number()) })
                .stream(async function* () {
                    yield { kind: "joined" };
                });
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes).toStrictEqual([
            {
                body: {},
                chunkType: "{ kind: string; }",
                exportName: "streamRoom",
                filePath: "http",
                method: "GET",
                params: { roomId: { kind: "string" } },
                path: "/api/rooms/:roomId/events",
                searchParams: { since: { inner: { kind: "number" }, kind: "optional" } },
                stream: true,
            },
        ]);
    });

    it("skips chains that don't bottom out in an `httpRoute` verb factory", () => {
        expect.assertions(1);

        writeSource(
            "http.ts",
            `
            const other = { get: (path: string) => ({ stream: (fn: unknown) => fn }) };

            export const notARoute = other.get("/nope").stream(async function* () {
                yield 1;
            });
        `,
        );

        expect(discoverHttpRoutes(newProject(), workdir)).toStrictEqual([]);
    });
});
