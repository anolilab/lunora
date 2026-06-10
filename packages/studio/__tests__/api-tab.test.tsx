import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import ApiTab from "../src/api-tab.js";
import type { FunctionDescriptor } from "../src/index.js";
import { createMockClient } from "./mock-client.js";

// eslint-disable-next-line vitest/prefer-import-in-mock -- the typed `import()` form requires the factory to match Scalar's full module shape; the string form lets the stub expose only what the tab renders
vi.mock("@scalar/api-reference-react", () => {
    const ApiReferenceReact = (): ReactElement => <div data-testid="scalar-stub" />;

    return { ApiReferenceReact };
});

const FUNCTIONS: FunctionDescriptor[] = [{ kind: "query", path: "messages:list" }];

const SPEC: Record<string, unknown> = {
    openapi: "3.1.0",
    paths: { "/_cirrus/rpc#messages:list": { post: { operationId: "messages:list" } } },
};

const RPC_SPEC: Record<string, unknown> = {
    methods: [{ name: "messages:list", params: [{ name: "args", schema: { type: "object" } }], result: { schema: {} }, "x-tags": [{ name: "messages" }] }],
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

        expect(screen.getByTestId("scalar-stub")).toBeDefined();
        // The snippets browser is not mounted while reference is active.
        expect(screen.queryByTestId("cirrus-api-docs")).toBeNull();
    });

    it("toggles to the snippets sub-view and back", () => {
        expect.assertions(3);

        render(renderTab());

        fireEvent.click(screen.getByTestId("api-view-snippets"));

        expect(screen.getByTestId("cirrus-api-docs")).toBeDefined();
        expect(screen.queryByTestId("scalar-stub")).toBeNull();

        fireEvent.click(screen.getByTestId("api-view-reference"));

        expect(screen.getByTestId("scalar-stub")).toBeDefined();
    });

    it("switches the reference format from OpenAPI (Scalar) to the OpenRPC view", () => {
        expect.assertions(3);

        render(renderTab());

        // OpenAPI (Scalar) is the default format.
        expect(screen.getByTestId("scalar-stub")).toBeDefined();

        fireEvent.click(screen.getByTestId("api-format-openrpc"));

        // The custom OpenRPC view renders; Scalar is unmounted.
        expect(screen.getByTestId("openrpc-reference")).toBeDefined();
        expect(screen.queryByTestId("scalar-stub")).toBeNull();
    });

    it("hides the format switch on the snippets sub-view", () => {
        expect.assertions(2);

        render(renderTab());

        expect(screen.getByTestId("api-format-toggle")).toBeDefined();

        fireEvent.click(screen.getByTestId("api-view-snippets"));

        expect(screen.queryByTestId("api-format-toggle")).toBeNull();
    });
});
