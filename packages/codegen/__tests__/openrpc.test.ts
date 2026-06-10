import { describe, expect, it } from "vitest";

import type { FunctionIR } from "../src/ir";
import { emitOpenRpc, OPENRPC_VERSION } from "../src/openrpc";
import { CIRRUS_ERROR_CODES } from "../src/schema-ir";

const makeFunction = (overrides: Partial<FunctionIR> = {}): FunctionIR => {
    return {
        args: {},
        exportName: "list",
        filePath: "messages",
        kind: "query",
        returnType: "unknown",
        ...overrides,
    };
};

interface OpenRpcMethod {
    errors?: { code: number; data: { code: string }; message: string }[];
    name: string;
    params: { name: string; required: boolean; schema: Record<string, unknown> }[];
    result: { name: string; schema: Record<string, unknown> };
    "x-cirrus-function-kind"?: string;
    "x-tags"?: { name: string }[];
}

interface OpenRpcDocument {
    info: { title: string; version: string };
    methods: OpenRpcMethod[];
    openrpc: string;
}

describe("emitOpenRpc", () => {
    it("emits a valid OpenRPC document skeleton", () => {
        expect.assertions(4);

        const document = JSON.parse(emitOpenRpc({ functions: [] })) as OpenRpcDocument;

        expect(document.openrpc).toBe(OPENRPC_VERSION);
        expect(document.info.title).toBe("Cirrus RPC");
        expect(document.info.version).toBe("0.0.0");
        expect(document.methods).toStrictEqual([]);
    });

    it("threads a provided info.version through", () => {
        expect.assertions(1);

        const document = JSON.parse(emitOpenRpc({ functions: [], version: "2.3.4" })) as OpenRpcDocument;

        expect(document.info.version).toBe("2.3.4");
    });

    it("models each RPC function as a method named file:fn with a single args param", () => {
        expect.assertions(5);

        const document = JSON.parse(
            emitOpenRpc({
                functions: [
                    makeFunction({ args: { channelId: { kind: "id", tableName: "channels" }, limit: { inner: { kind: "number" }, kind: "optional" } } }),
                ],
            }),
        ) as OpenRpcDocument;

        expect(document.methods).toHaveLength(1);

        const method = document.methods[0]!;

        expect(method.name).toBe("messages:list");
        expect(method.params).toHaveLength(1);
        expect(method.params[0]!.name).toBe("args");
        // The args param schema is an object with the function's declared properties.
        expect(method.params[0]!.schema).toMatchObject({ properties: { channelId: {}, limit: {} }, type: "object" });
    });

    it("marks the args param required only when the function declares required args", () => {
        expect.assertions(2);

        const withArgs = JSON.parse(emitOpenRpc({ functions: [makeFunction({ args: { id: { kind: "string" } } })] })) as OpenRpcDocument;
        const withoutArgs = JSON.parse(emitOpenRpc({ functions: [makeFunction({ args: {} })] })) as OpenRpcDocument;

        expect(withArgs.methods[0]!.params[0]!.required).toBe(true);
        expect(withoutArgs.methods[0]!.params[0]!.required).toBe(false);
    });

    it("excludes internal and stream functions, like the OpenAPI emitter", () => {
        expect.assertions(3);

        const document = JSON.parse(
            emitOpenRpc({
                functions: [
                    makeFunction({ exportName: "list", kind: "query" }),
                    makeFunction({ exportName: "purge", kind: "mutation", visibility: "internal" }),
                    makeFunction({ exportName: "feed", kind: "stream" }),
                ],
            }),
        ) as OpenRpcDocument;

        expect(document.methods).toHaveLength(1);
        expect(document.methods[0]!.name).toBe("messages:list");
        expect(document.methods.some((method) => method.name === "messages:purge" || method.name === "messages:feed")).toBe(false);
    });

    it("enumerates the standard Cirrus error codes under each method's errors", () => {
        expect.assertions(3);

        const document = JSON.parse(emitOpenRpc({ functions: [makeFunction()] })) as OpenRpcDocument;
        const errors = document.methods[0]!.errors ?? [];

        expect(errors).toHaveLength(CIRRUS_ERROR_CODES.length);

        const codes = errors.map((error) => error.data.code);

        expect(codes).toContain("UNAUTHORIZED");
        expect(codes).toContain("NOT_FOUND");
    });

    it("carries the function kind and a file-namespace x-tag", () => {
        expect.assertions(2);

        const document = JSON.parse(
            emitOpenRpc({ functions: [makeFunction({ filePath: "rooms/index", kind: "mutation", exportName: "create" })] }),
        ) as OpenRpcDocument;
        const method = document.methods[0]!;

        expect(method["x-cirrus-function-kind"]).toBe("mutation");
        // `rooms/index` collapses to the `rooms` namespace.
        expect(method["x-tags"]).toStrictEqual([{ name: "rooms" }]);
    });

    it("sorts methods by name and ends with a trailing newline", () => {
        expect.assertions(2);

        const rendered = emitOpenRpc({
            functions: [makeFunction({ exportName: "send" }), makeFunction({ exportName: "list" })],
        });
        const document = JSON.parse(rendered) as OpenRpcDocument;

        expect(document.methods.map((method) => method.name)).toStrictEqual(["messages:list", "messages:send"]);
        expect(rendered.endsWith("}\n")).toBe(true);
    });
});
