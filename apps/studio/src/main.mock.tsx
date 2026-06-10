import "./index.css";

import type { FunctionDescriptor, StudioAppProps } from "@cirrus/studio";
import { StudioApp } from "@cirrus/studio";
import { createRoot } from "react-dom/client";

import { createDevMockClient } from "./mock/dev-client.js";

// Mirrors the mock client's `listFunctions` so the API docs panel has registered
// functions to document — the shell takes the list as a prop, not via the client.
const MOCK_FUNCTIONS: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
    { kind: "mutation", path: "posts:publish" },
    { kind: "action", path: "posts:syncToStripe" },
];

// A representative OpenAPI 3.1 document so the API tab's reference (Scalar) view
// renders real operations in the design harness, threaded inline as the studio
// prop (mirrors how the host wires the generated `_generated/openapi.json`).
const MOCK_OPENAPI_SPEC: Record<string, unknown> = {
    components: {
        responses: {
            CirrusError: {
                content: {
                    "application/json": {
                        schema: {
                            properties: {
                                error: {
                                    properties: {
                                        code: { enum: ["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"], type: "string" },
                                        message: { type: "string" },
                                    },
                                    required: ["code", "message"],
                                    type: "object",
                                },
                            },
                            required: ["error"],
                            type: "object",
                        },
                    },
                },
                description: "A Cirrus error response.",
            },
        },
    },
    info: { description: "Mock spec for the studio design harness.", title: "Cirrus API", version: "0.0.0" },
    openapi: "3.1.0",
    paths: {
        "/_cirrus/rpc#messages:list": {
            post: {
                operationId: "messages:list",
                requestBody: {
                    content: {
                        "application/json": {
                            schema: {
                                properties: {
                                    args: { properties: { channelId: { type: "string" } }, required: ["channelId"], type: "object" },
                                    functionPath: { const: "messages:list", type: "string" },
                                },
                                required: ["functionPath"],
                                type: "object",
                            },
                        },
                    },
                    required: true,
                },
                responses: { "200": { description: "Successful RPC result." }, default: { $ref: "#/components/responses/CirrusError" } },
                summary: "query: messages:list",
                tags: ["messages"],
            },
        },
        "/_cirrus/rpc#messages:send": {
            post: {
                operationId: "messages:send",
                responses: { "200": { description: "Successful RPC result." }, default: { $ref: "#/components/responses/CirrusError" } },
                summary: "mutation: messages:send",
                tags: ["messages"],
            },
        },
    },
    tags: [{ description: "Operations declared in `cirrus/messages`.", name: "messages" }],
};

// Hoisted to module scope so the JSX prop is a single stable object, not a fresh
// one per render. The rule still flags the literal because it can't prove the
// const never re-evaluates; at module top level it evaluates exactly once.
// `dataEditable` is on so the harness exercises the inline cell editor + staged
// commit flow during design iteration; the mock records writes without a backend.
// eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- module-level constant, evaluated once
const STUDIO_OPTIONS: StudioAppProps["studio"] = { dataEditable: true, functions: MOCK_FUNCTIONS, openApiSpec: MOCK_OPENAPI_SPEC };

// Dev-only harness: render the full studio chrome against a backend-free mock
// client (see `mock/dev-client.ts`), so every panel paints with representative
// data for design/screenshot iteration. Reached at `/mock.html` in dev.
const element = document.querySelector("#root");

if (element === null) {
    throw new Error("main.mock: #root not found");
}

createRoot(element).render(<StudioApp client={createDevMockClient()} studio={STUDIO_OPTIONS} />);
