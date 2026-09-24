import { LunoraProvider } from "@lunora/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import ApiReferencePanel from "../../../src/features/api/api-reference-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SPEC_WITH_PATHS: Record<string, unknown> = {
    info: { title: "Lunora API", version: "1.0.0" },
    openapi: "3.1.0",
    paths: {
        "/_lunora/rpc#messages:list": {
            post: { operationId: "messages:list", summary: "query: messages:list", tags: ["messages"], "x-lunora-function-kind": "query" },
        },
    },
};

const SPEC_WITH_RESPONSE: Record<string, unknown> = {
    info: { title: "Lunora API", version: "1.0.0" },
    openapi: "3.1.0",
    paths: {
        "/_lunora/rpc#messages:list": {
            post: {
                operationId: "messages:list",
                responses: {
                    "200": { content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } }, description: "OK" },
                },
                summary: "query: messages:list",
                tags: ["messages"],
                "x-lunora-function-kind": "query",
            },
        },
    },
};

const EMPTY_SPEC: Record<string, unknown> = { info: { title: "Lunora API", version: "0.0.0" }, openapi: "3.1.0", paths: {} };

const renderPanel = (mock: MockClientHooks, spec?: unknown): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <ApiReferencePanel spec={spec} />
    </LunoraProvider>
);

describe("apiReferencePanel", () => {
    it("renders the native reference over a spec fetched from the worker", async () => {
        expect.assertions(2);

        const mock = createMockClient({ fetchOpenApi: () => SPEC_WITH_PATHS });

        render(renderPanel(mock));

        // The reference view mounts and the fetched operation appears in the nav.
        await expect(screen.findByTestId("api-reference")).resolves.toBeDefined();
        expect(screen.getByTestId("api-nav-messages:list")).toBeDefined();
    });

    it("renders an inline spec directly without fetching", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_PATHS));

        await expect(screen.findByTestId("api-reference")).resolves.toBeDefined();
        // The inline path never hits the client's fetch accessor.
        expect(mock.fetchOpenApi).not.toHaveBeenCalled();
    });

    it("renders a documented response example as a status tab in the right rail before any send", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_RESPONSE));

        // The 200 response surfaces as a tab on the right-rail response panel…
        await expect(screen.findByTestId("api-response-tab-200")).resolves.toBeDefined();
        // …and its body is the example seeded from the response schema (no request sent).
        expect(screen.getByTestId("api-response-body").textContent).toContain('"id"');
    });

    it("renders nested fields and constraint badges in the response schema", async () => {
        expect.assertions(4);

        const SPEC_WITH_SCHEMA: Record<string, unknown> = {
            info: { title: "Lunora API", version: "1.0.0" },
            openapi: "3.1.0",
            paths: {
                "/_lunora/rpc#planets:get": {
                    post: {
                        operationId: "planets:get",
                        responses: {
                            "200": {
                                content: {
                                    "application/json": {
                                        schema: {
                                            properties: {
                                                id: { format: "int64", type: "integer" },
                                                physicalProperties: { properties: { mass: { type: "number" } }, type: "object" },
                                                type: { anyOf: [{ const: "terrestrial" }, { const: "gas_giant" }] },
                                            },
                                            required: ["id"],
                                            type: "object",
                                        },
                                    },
                                },
                                description: "OK",
                            },
                        },
                        summary: "query: planets:get",
                        tags: ["planets"],
                        "x-lunora-function-kind": "query",
                    },
                },
            },
        };

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_SCHEMA));

        const table = await screen.findByTestId("api-response-200");

        expect(table.textContent).toContain("int64"); // Format badge value
        expect(table.textContent).toContain("Value in"); // enum (anyOf of consts) badge
        expect(table.textContent).toContain("physicalProperties"); // nested object field
        expect(table.textContent).toContain("mass"); // recursed sub-field
    });

    it("shows the not-configured empty state for a pathless spec", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenApi: () => EMPTY_SPEC });

        render(renderPanel(mock));

        await expect(screen.findByTestId("api-reference-empty")).resolves.toBeDefined();
    });

    it("shows an error state when the fetch fails", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.fetchOpenApi.mockRejectedValueOnce(new Error("403 forbidden"));

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("api-reference-error")).toBeDefined();
        });
    });

    it("fetches the spec once, whatever identity the caller's fetcher has", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenApi: () => SPEC_WITH_PATHS });

        render(renderPanel(mock));

        await screen.findByTestId("api-reference");

        // The resolved spec is classified into a fresh object, so a re-render was
        // always going to follow the fetch. If the fetch is keyed on the caller's
        // callback identity, that re-render mints a new one and refetches — forever.
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mock.fetchOpenApi).toHaveBeenCalledTimes(1);
    });
});
