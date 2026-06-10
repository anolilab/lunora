import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import type { FunctionIR, HttpRouteIR } from "../src/ir";
import { buildOpenApiDocument, emitOpenApi, emitOpenApiModule } from "../src/openapi";
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

const makeRoute = (overrides: Partial<HttpRouteIR> = {}): HttpRouteIR => {
    return {
        body: {},
        exportName: "listTodos",
        filePath: "http",
        method: "GET",
        params: {},
        path: "/api/todos",
        searchParams: {},
        stream: false,
        ...overrides,
    };
};

describe("emitOpenApi", () => {
    it("emits a valid OpenAPI 3.1.0 document skeleton", () => {
        expect.assertions(4);

        const document = JSON.parse(emitOpenApi({ functions: [], httpRoutes: [] }));

        expect(document.openapi).toBe("3.1.0");
        expect(document.info.title).toBe("Cirrus API");
        expect(document.info.version).toBe("0.0.0");
        expect(document.paths).toStrictEqual({});
    });

    it("threads a provided info.version through", () => {
        expect.assertions(1);

        const document = JSON.parse(emitOpenApi({ functions: [], httpRoutes: [], version: "1.4.2" }));

        expect(document.info.version).toBe("1.4.2");
    });

    it("models each RPC function as a distinct POST operation on /_cirrus/rpc with a const functionPath", () => {
        expect.assertions(6);

        const document = JSON.parse(
            emitOpenApi({
                functions: [
                    makeFunction({ args: { channelId: { kind: "id", tableName: "channels" }, limit: { inner: { kind: "number" }, kind: "optional" } } }),
                ],
                httpRoutes: [],
            }),
        );

        const operation = document.paths["/_cirrus/rpc#messages:list"].post;

        expect(operation.operationId).toBe("messages:list");
        expect(operation.tags).toStrictEqual(["messages"]);
        expect(operation["x-cirrus-function-kind"]).toBe("query");

        const requestSchema = operation.requestBody.content["application/json"].schema;

        // functionPath is pinned to a const so the operation maps to exactly one function.
        expect(requestSchema.properties.functionPath.const).toBe("messages:list");
        // args carries the validator-derived schema; `limit` is optional so it drops out of `required`.
        expect(requestSchema.properties.args.required).toStrictEqual(["channelId"]);
        expect(requestSchema.properties.shardKey.type).toBe("string");
    });

    it("excludes internal and stream functions from the RPC surface", () => {
        expect.assertions(3);

        const document = JSON.parse(
            emitOpenApi({
                functions: [
                    makeFunction({ exportName: "list" }),
                    makeFunction({ exportName: "purge", kind: "mutation", visibility: "internal" }),
                    makeFunction({ exportName: "feed", kind: "stream" }),
                ],
                httpRoutes: [],
            }),
        );

        expect(document.paths["/_cirrus/rpc#messages:list"]).toBeDefined();
        expect(document.paths["/_cirrus/rpc#messages:purge"]).toBeUndefined();
        expect(document.paths["/_cirrus/rpc#messages:feed"]).toBeUndefined();
    });

    it("emits an httpRouter route as a real path with query parameters and an output schema", () => {
        expect.assertions(5);

        const document = JSON.parse(
            emitOpenApi({
                functions: [],
                httpRoutes: [
                    makeRoute({
                        output: { kind: "object", shape: { ok: { kind: "boolean" } } },
                        searchParams: { limit: { inner: { kind: "number" }, kind: "optional" } },
                    }),
                ],
            }),
        );

        const operation = document.paths["/api/todos"].get;

        expect(operation.operationId).toBe("get__api_todos");
        expect(operation.summary).toBe("GET /api/todos");
        expect(operation.parameters[0]).toMatchObject({ in: "query", name: "limit", required: false });
        expect(operation.responses["200"].content["application/json"].schema.properties.ok.type).toBe("boolean");
        expect(operation.responses.default.$ref).toBe("#/components/responses/CirrusError");
    });

    it("converts a :param path to an OpenAPI {param} template with a required path parameter and a requestBody", () => {
        expect.assertions(4);

        const document = JSON.parse(
            emitOpenApi({
                functions: [],
                httpRoutes: [
                    makeRoute({
                        body: { text: { kind: "string" } },
                        exportName: "getTodo",
                        method: "POST",
                        params: { id: { kind: "string" } },
                        path: "/api/todos/:id",
                    }),
                ],
            }),
        );

        const operation = document.paths["/api/todos/{id}"].post;

        expect(operation).toBeDefined();
        expect(operation.parameters[0]).toMatchObject({ in: "path", name: "id", required: true });
        expect(operation.requestBody.required).toBe(true);
        expect(operation.requestBody.content["application/json"].schema.properties.text.type).toBe("string");
    });

    it("merges multiple verbs on one path into a single path item", () => {
        expect.assertions(2);

        const document = JSON.parse(
            emitOpenApi({
                functions: [],
                httpRoutes: [makeRoute({ method: "GET", path: "/api/todos" }), makeRoute({ exportName: "createTodo", method: "POST", path: "/api/todos" })],
            }),
        );

        expect(document.paths["/api/todos"].get).toBeDefined();
        expect(document.paths["/api/todos"].post).toBeDefined();
    });

    it("emits a reusable CirrusError response component enumerating the standard error codes", () => {
        expect.assertions(4);

        const document = JSON.parse(emitOpenApi({ functions: [makeFunction()], httpRoutes: [] }));

        const component = document.components.responses.CirrusError;
        const codeEnum = component.content["application/json"].schema.properties.error.properties.code.enum;

        expect(component).toBeDefined();
        expect(codeEnum).toStrictEqual([...CIRRUS_ERROR_CODES]);
        expect(codeEnum).toContain("UNAUTHORIZED");
        expect(codeEnum).toContain("FUNCTION_NOT_FOUND");
    });

    it("groups operations into tags by file namespace", () => {
        expect.assertions(2);

        const document = JSON.parse(
            emitOpenApi({
                functions: [makeFunction({ filePath: "messages" })],
                httpRoutes: [makeRoute({ filePath: "http" })],
            }),
        );

        const tagNames = (document.tags as { name: string }[]).map((tag) => tag.name);

        expect(tagNames).toContain("messages");
        expect(tagNames).toContain("http");
    });
});

describe("emitOpenApiModule", () => {
    const input = {
        functions: [makeFunction({ filePath: "messages" })],
        httpRoutes: [makeRoute({ filePath: "http" })],
    };

    it("emits a do-not-edit header and an `openApiSpec` named export", () => {
        expect.assertions(3);

        const moduleSource = emitOpenApiModule(buildOpenApiDocument(input));

        expect(moduleSource).toContain("// GENERATED by @cirrus/codegen — do not edit.");
        expect(moduleSource).toContain("cirrus codegen");
        expect(moduleSource).toContain("export const openApiSpec: Record<string, unknown> = {");
    });

    it("parses as valid TS exporting `openApiSpec` whose value equals the JSON document", () => {
        expect.assertions(2);

        const document = buildOpenApiDocument(input);
        const moduleSource = emitOpenApiModule(document);

        // Parse the emitted module and confirm it surfaces the export with no
        // diagnostics — guards against a malformed object literal.
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile("openapi.ts", moduleSource);

        expect(sourceFile.getExportedDeclarations().has("openApiSpec")).toBe(true);

        // The inlined object literal must be byte-identical to the document the
        // `.json` artifact serializes (same source of truth, no recompute/drift).
        const inlined = moduleSource.slice(moduleSource.indexOf("= ") + 2, moduleSource.lastIndexOf(";"));

        expect(JSON.parse(inlined)).toStrictEqual(document);
    });

    it("inlines the same document `emitOpenApi` stringifies (json ↔ ts agree)", () => {
        expect.assertions(1);

        const document = buildOpenApiDocument(input);
        const fromModule = emitOpenApiModule(document);
        const inlined = fromModule.slice(fromModule.indexOf("= ") + 2, fromModule.lastIndexOf(";"));

        expect(JSON.parse(inlined)).toStrictEqual(JSON.parse(emitOpenApi(input)));
    });
});
