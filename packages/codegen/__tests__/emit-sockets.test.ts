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

    it("keeps the registry out of a route-free project", () => {
        expect.assertions(2);

        // The interface docblock does not name the map, so assert on the EXPORT
        // and the lifecycle member — both absent without a route.
        expect(emitFunctions({ functions: [] })).not.toContain("export const LUNORA_SOCKETS");
        expect(emitFunctions({ functions: [] })).not.toContain('"socket"');
    });
});
