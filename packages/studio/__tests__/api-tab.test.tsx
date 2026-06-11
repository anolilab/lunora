import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import ApiTab from "../src/api-tab.js";
import type { FunctionDescriptor } from "../src/index.js";
import { createMockClient } from "./mock-client.js";

const FUNCTIONS: FunctionDescriptor[] = [{ kind: "query", path: "messages:list" }];

const SPEC: Record<string, unknown> = {
    openapi: "3.1.0",
    paths: {
        "/_cirrus/rpc#messages:list": {
            post: { operationId: "messages:list", summary: "query: messages:list", tags: ["messages"], "x-cirrus-function-kind": "query" },
        },
    },
};

const RPC_SPEC: Record<string, unknown> = {
    methods: [{ name: "users:listRpc", params: [{ name: "args", schema: { type: "object" } }], result: { schema: {} }, "x-tags": [{ name: "users" }] }],
    openrpc: "1.3.2",
};

const renderTab = (): ReactElement => (
    <CirrusProvider client={createMockClient().asClient}>
        <ApiTab functions={FUNCTIONS} openApiSpec={SPEC} openRpcSpec={RPC_SPEC} />
    </CirrusProvider>
);

describe("apiTab", () => {
    it("defaults to the reference sub-view", () => {
        expect.assertions(2);

        render(renderTab());

        expect(screen.getByTestId("api-reference")).toBeDefined();
        // The snippets browser is not mounted while reference is active.
        expect(screen.queryByTestId("cirrus-api-docs")).toBeNull();
    });

    it("toggles to the snippets sub-view and back", () => {
        expect.assertions(3);

        render(renderTab());

        fireEvent.click(screen.getByTestId("api-view-snippets"));

        expect(screen.getByTestId("cirrus-api-docs")).toBeDefined();
        expect(screen.queryByTestId("api-reference")).toBeNull();

        fireEvent.click(screen.getByTestId("api-view-reference"));

        expect(screen.getByTestId("api-reference")).toBeDefined();
    });

    it("switches the reference format from OpenAPI to the OpenRPC view", () => {
        expect.assertions(3);

        render(renderTab());

        // OpenAPI is the default format — its operation is in the nav.
        expect(screen.getByTestId("api-nav-messages:list")).toBeDefined();

        fireEvent.click(screen.getByTestId("api-format-openrpc"));

        // The OpenRPC document now drives the same reference UI; its method is in the nav.
        expect(screen.getByTestId("api-nav-users:listRpc")).toBeDefined();
        expect(screen.queryByTestId("api-nav-messages:list")).toBeNull();
    });

    it("hides the format switch on the snippets sub-view", () => {
        expect.assertions(2);

        render(renderTab());

        expect(screen.getByTestId("api-format-toggle")).toBeDefined();

        fireEvent.click(screen.getByTestId("api-view-snippets"));

        expect(screen.queryByTestId("api-format-toggle")).toBeNull();
    });
});
