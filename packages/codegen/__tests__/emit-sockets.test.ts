import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";

import { emitFunctions, emitShard } from "../src/emit";
import type { FunctionIR } from "../src/ir";

/**
 * The generated half of `defineWebSocket`: the `LUNORA_SOCKETS` path→
 * registration registry and the ShardDO `socketRoute` override that resolves an
 * upgraded socket through it. Both are gated on a declared route so a
 * route-free project's output is byte-identical.
 */
const socketFunction: FunctionIR = {
    args: {},
    exportName: "chatSocket",
    filePath: "sockets",
    kind: "mutation",
    lifecycle: "socket",
    returnType: "void",
    visibility: "internal",
};

describe("emitShard — socketRoute override", () => {
    it("resolves an upgraded socket through the generated LUNORA_SOCKETS map", () => {
        expect.assertions(3);

        const emitted = emitShard({ hasSockets: true, schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).toContain("protected override socketRoute(path: string): { auth: boolean; functionPath: string } | undefined {");
        expect(emitted).toContain("return LUNORA_SOCKETS[path];");
        // The registry is imported from the generated functions module.
        expect(emitted).toMatch(/import \{[^}]*LUNORA_SOCKETS[^}]*\} from "\.\/functions\.js";/u);
    });

    it("omits the override when no route is declared, so the base default applies", () => {
        expect.assertions(2);

        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).not.toContain("socketRoute");
        expect(emitted).not.toContain("LUNORA_SOCKETS");
    });
});

describe("emitFunctions — LUNORA_SOCKETS registry", () => {
    it("keys the registry on the route's declared path", () => {
        expect.assertions(5);

        const emitted = emitFunctions({ functions: [socketFunction] });

        expect(emitted).toContain("export const LUNORA_SOCKETS: Readonly<Record<string, { auth: boolean; functionPath: string }>>");
        // The key is the SAME path the worker recognises the upgrade at.
        expect(emitted).toContain("registry[fn.socketPath] = { auth: fn.auth === true, functionPath: path };");
        // Two routes on one path fail at module load rather than overwrite each other.
        expect(emitted).toContain("socket paths must be unique");
        expect(emitted).toContain("auth: fn.auth === true");
        // The lifecycle union carries the new member only when a route exists.
        expect(emitted).toContain('lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "whisper" | "socket";');
    });

    it("runs the emitted registry: an alias is one route, and two routes on one path throw", () => {
        expect.assertions(3);

        // Evaluate the emitted block, not a string match on it: transpile the registry
        // and run it against a stubbed function table, as the room registry test does.
        const emitted = emitFunctions({ functions: [socketFunction] });
        const start = emitted.indexOf("export const LUNORA_SOCKETS");
        const block = emitted.slice(start, emitted.indexOf("})();", start) + "})();".length);
        const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const registryOf = (functions: Record<string, unknown>): unknown => {
            const exported: Record<string, unknown> = {};

            // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- the test runs the emitted registry it just transpiled
            new Function("LUNORA_FUNCTIONS", "exports", js)(functions, exported);

            return exported["LUNORA_SOCKETS"];
        };
        const route = { auth: true, lifecycle: "socket", socketPath: "/chat" };

        expect(registryOf({ "sockets:chat": route })).toStrictEqual({ "/chat": { auth: true, functionPath: "sockets:chat" } });
        // An alias: one registration exported under two names is one route, not a clash.
        expect(registryOf({ "sockets:chat": route, "sockets:lobby": route })).toStrictEqual({ "/chat": { auth: true, functionPath: "sockets:chat" } });
        // Two distinct registrations on one path are a real clash.
        expect(() =>
            registryOf({
                "sockets:a": { auth: false, lifecycle: "socket", socketPath: "/chat" },
                "sockets:b": { auth: false, lifecycle: "socket", socketPath: "/chat" },
            }),
        ).toThrow(/socket paths must be unique/u);
    });

    it("emits a static registry in lazy mode, with each route's literal path and auth", () => {
        expect.assertions(3);

        // Lazy mode holds the route only as a stub in LUNORA_FUNCTIONS, so the registry is read from the discovered
        // literal `path`/`auth`, not walked from the table. Evaluate the emitted literal to check what it maps to.
        const emitted = emitFunctions({
            functions: [{ ...socketFunction, socket: { auth: true, path: "/chat" } }],
            lazyFunctions: true,
        });
        const start = emitted.indexOf("export const LUNORA_SOCKETS");
        const block = emitted.slice(start, emitted.indexOf("};", start) + "};".length);
        const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exported: Record<string, unknown> = {};

        // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- the test runs the emitted registry it just transpiled
        new Function("exports", js)(exported);

        expect(exported["LUNORA_SOCKETS"]).toStrictEqual({ "/chat": { auth: true, functionPath: "sockets:chatSocket" } });
        // The lazy registry does not depend on the route module, so the stubbed table is never read.
        expect(emitted).not.toContain("fn.socketPath");
        expect(emitted).toContain('lifecycle?: "connect" | "disconnect" | "init" | "reactor" | "whisper" | "socket";');
    });

    it("accepts a lazy route exported under two names, and carries its path onto the worker's stubs", () => {
        expect.assertions(3);

        const origin = "sockets.ts@1";
        const emitted = emitFunctions({
            functions: [
                { ...socketFunction, socket: { auth: false, origin, path: "/chat" } },
                { ...socketFunction, exportName: "lobbySocket", socket: { auth: false, origin, path: "/chat" } },
            ],
            lazyFunctions: true,
        });
        const start = emitted.indexOf("export const LUNORA_SOCKETS");
        const block = emitted.slice(start, emitted.indexOf("};", start) + "};".length);
        const js = ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const exported: Record<string, unknown> = {};

        // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- the test runs the emitted registry it just transpiled
        new Function("exports", js)(exported);

        expect(exported["LUNORA_SOCKETS"]).toStrictEqual({ "/chat": { auth: false, functionPath: "sockets:chatSocket" } });
        // The worker finds the route on the stub, without evaluating the module.
        expect(emitted).toContain('"socketPath":"/chat"');
        expect(emitted).toContain('"auth":false');
    });

    it("refuses two lazy routes on one path at codegen time", () => {
        expect.assertions(1);

        expect(() =>
            emitFunctions({
                functions: [
                    { ...socketFunction, socket: { auth: false, path: "/chat" } },
                    { ...socketFunction, exportName: "lobbySocket", socket: { auth: false, path: "/chat" } },
                ],
                lazyFunctions: true,
            }),
        ).toThrow(/socket paths must be unique/u);
    });

    it("keeps the registry out of a route-free project", () => {
        expect.assertions(2);

        // The interface docblock does not name the map, so assert on the EXPORT
        // and the lifecycle member — both absent without a route.
        expect(emitFunctions({ functions: [] })).not.toContain("export const LUNORA_SOCKETS");
        expect(emitFunctions({ functions: [] })).not.toContain('"socket"');
    });
});
