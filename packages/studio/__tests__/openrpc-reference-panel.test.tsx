import { CirrusProvider } from "@cirrus/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import OpenRpcReferencePanel from "../src/openrpc-reference-panel.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

const SPEC_WITH_METHODS: Record<string, unknown> = {
    methods: [
        {
            description: "List messages.",
            name: "messages:list",
            params: [{ name: "args", required: true, schema: { properties: { channelId: { type: "string" } }, required: ["channelId"], type: "object" } }],
            result: { name: "result", schema: {} },
            "x-cirrus-function-kind": "query",
            "x-tags": [{ name: "messages" }],
        },
    ],
    openrpc: "1.3.2",
};

const EMPTY_SPEC: Record<string, unknown> = { methods: [], openrpc: "1.3.2" };

const renderPanel = (mock: MockClientHooks, spec?: unknown): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <OpenRpcReferencePanel spec={spec} />
    </CirrusProvider>
);

describe("openRpcReferencePanel", () => {
    it("renders methods grouped by namespace from a spec fetched from the worker", async () => {
        expect.assertions(3);

        const mock = createMockClient({ fetchOpenRpc: () => SPEC_WITH_METHODS });

        render(renderPanel(mock));

        await expect(screen.findByTestId("openrpc-reference")).resolves.toBeDefined();
        expect(screen.getByTestId("openrpc-method-messages:list")).toBeDefined();
        // The params table renders the declared arg property.
        expect(screen.getByTestId("openrpc-params-messages:list")).toBeDefined();
    });

    it("builds a JSON-RPC request example for each method", async () => {
        expect.assertions(2);

        const mock = createMockClient({ fetchOpenRpc: () => SPEC_WITH_METHODS });

        render(renderPanel(mock));

        const example = await screen.findByTestId("openrpc-example-messages:list");

        expect(example.textContent).toContain('"jsonrpc": "2.0"');
        expect(example.textContent).toContain('"method": "messages:list"');
    });

    it("renders an inline spec directly without fetching", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_METHODS));

        await expect(screen.findByTestId("openrpc-reference")).resolves.toBeDefined();
        expect(mock.fetchOpenRpc).not.toHaveBeenCalled();
    });

    it("shows the not-configured empty state for a methodless spec", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenRpc: () => EMPTY_SPEC });

        render(renderPanel(mock));

        await expect(screen.findByTestId("openrpc-reference-empty")).resolves.toBeDefined();
    });

    it("shows an error state when the fetch fails", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.fetchOpenRpc.mockRejectedValueOnce(new Error("403 forbidden"));

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("openrpc-reference-error")).toBeDefined();
        });
    });
});
