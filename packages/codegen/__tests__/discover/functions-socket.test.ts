import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverFunctions from "../../src/discover/functions";
import { emitFunctions } from "../../src/emit";

/**
 * Discovery of `defineWebSocket`.
 *
 * A route the discoverer does not recognise still registers as *something* — it
 * just never lands in `LUNORA_SOCKETS`, so the worker never recognises its path
 * as an upgrade route and the shard has no registration to dispatch. Nothing
 * throws and the symptom is a socket that connects into the app router and
 * silently never opens. So the case asserts the discovered tag AND that the
 * registration reaches the emitted `LUNORA_SOCKETS` map, since that map is what
 * the runtime actually reads.
 */
let workdir: string;

describe("discoverFunctions — defineWebSocket", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-socket-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFunction = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
        writeFileSync(full, source);
    };

    const discover = (): ReturnType<typeof discoverFunctions> =>
        discoverFunctions(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), workdir);

    it("tags a defineWebSocket export as an internal `socket` mutation", () => {
        expect.assertions(4);

        writeFunction(
            "sockets.ts",
            `
            import { defineWebSocket, v } from "@lunora/server";
            export const chat = defineWebSocket({ message: v.object({ text: v.string() }), onMessage: () => undefined, path: "/chat" });
        `,
        );

        const [chat] = discover();

        expect(chat?.lifecycle).toBe("socket");
        // A client must never be able to invoke a route's handler by path.
        expect(chat?.visibility).toBe("internal");
        expect(chat?.kind).toBe("mutation");
        // The registration reaches the emitted registry the runtime reads.
        expect(emitFunctions({ functions: discover() })).toContain("export const LUNORA_SOCKETS");
    });

    it("discovers a route declared through a namespace import", () => {
        expect.assertions(2);

        writeFunction(
            "sockets.ts",
            `
            import * as lunora from "@lunora/server";
            export const chat = lunora.defineWebSocket({ message: lunora.v.object({ text: lunora.v.string() }), onMessage: () => undefined, path: "/chat" });
        `,
        );

        const [chat] = discover();

        expect(chat?.lifecycle).toBe("socket");
        expect(emitFunctions({ functions: discover() })).toContain("export const LUNORA_SOCKETS");
    });

    it("keeps a socket route out of the socket-lifecycle manifest", () => {
        expect.assertions(1);

        writeFunction(
            "sockets.ts",
            `
            import { defineWebSocket, v } from "@lunora/server";
            export const chat = defineWebSocket({ message: v.object({}), onMessage: () => undefined, path: "/chat" });
        `,
        );

        const emitted = emitFunctions({ functions: discover() });
        const start = emitted.indexOf("export const LUNORA_LIFECYCLE_HOOKS");
        const manifest = emitted.slice(start, emitted.indexOf("};", start));

        // A route is dispatched through `LUNORA_SOCKETS`, never the socket
        // lifecycle manifest — a route path there would be dispatched by the
        // wrong mechanism at the wrong time.
        expect(manifest).not.toContain("sockets:chat");
    });
});
