import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverHttpRoutes from "../../src/discover/http-routes";

let workdir: string;

describe("discover/http-routes", () => {
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

    /** A stand-in for the published `@lunora/server` package, so its `SseEvent` resolves to a real declaration. */
    const writeServerPackage = (): void => {
        writeSource("node_modules/@lunora/server/package.json", JSON.stringify({ name: "@lunora/server", types: "index.d.ts" }));
        writeSource(
            "node_modules/@lunora/server/index.d.ts",
            `
            export interface SseEvent<R> { readonly data: R; readonly id: string; }
            export declare const httpRoute: any;
            export declare function sseEvent<R>(frame: { data: R; id: string }): SseEvent<R>;
        `,
        );
    };

    it("collapses a genuine @lunora/server `SseEvent` wrapper out of a `.stream()` chunk type", () => {
        expect.assertions(1);

        // The wrapper is transport, not part of the user's chunk contract: the
        // server puts only its inner `data` on the wire, so the client chunk type
        // must be the inner type even when a handler mixes branded + plain chunks.
        writeServerPackage();
        writeSource(
            "http.ts",
            `
            import { httpRoute, type SseEvent } from "@lunora/server";

            const iterate = async function* (): AsyncGenerator<SseEvent<{ text: string }> | { text: string }, void, void> {
                yield { text: "a" };
            };

            export const streamTokens = httpRoute.get("/api/tokens").stream(() => iterate());
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes[0]?.chunkType).toBe("{ text: string; }");
    });

    it("keeps a user's own `SseEvent` type: only the genuine envelope is unwrapped", () => {
        expect.assertions(1);

        // A local `SseEvent<T>` is an ordinary payload — the wire sends it whole — so it must not collapse.
        writeSource(
            "http.ts",
            `
            import { httpRoute } from "@lunora/server";

            interface SseEvent<R> {
                readonly data: R;
                readonly id: string;
            }

            const iterate = async function* (): AsyncGenerator<SseEvent<{ text: string }>, void, void> {
                yield { data: { text: "a" }, id: "1" };
            };

            export const streamTokens = httpRoute.get("/api/tokens").stream(() => iterate());
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes[0]?.chunkType).not.toBe("{ text: string; }");
    });

    it("renders a union envelope `SseEvent<A | B> | A | B` as the flattened chunk union", () => {
        expect.assertions(1);

        writeServerPackage();
        writeSource(
            "http.ts",
            `
            import { httpRoute, type SseEvent } from "@lunora/server";

            type A = { kind: "a" };
            type B = { kind: "b" };

            const iterate = async function* (): AsyncGenerator<SseEvent<A | B> | A | B, void, void> {
                yield { kind: "a" };
            };

            export const streamTokens = httpRoute.get("/api/tokens").stream(() => iterate());
        `,
        );

        const routes = discoverHttpRoutes(newProject(), workdir);

        expect(routes[0]?.chunkType).toBe('{ kind: "a" } | { kind: "b" }');
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
