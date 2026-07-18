import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import OpenRpcReferencePanel from "../../../src/features/api/openrpc-reference-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SPEC_WITH_METHODS: Record<string, unknown> = {
    methods: [
        {
            description: "List messages.",
            name: "messages:list",
            params: [{ name: "args", required: true, schema: { properties: { channelId: { type: "string" } }, required: ["channelId"], type: "object" } }],
            result: { name: "result", schema: {} },
            "x-lunora-function-kind": "query",
            "x-tags": [{ name: "messages" }],
        },
    ],
    openrpc: "1.3.2",
};

const EMPTY_SPEC: Record<string, unknown> = { methods: [], openrpc: "1.3.2" };

const renderPanel = (mock: MockClientHooks, spec?: unknown): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <OpenRpcReferencePanel spec={spec} />
    </LunoraProvider>
);

describe("openRpcReferencePanel", () => {
    it("renders methods in the shared reference UI from a spec fetched from the worker", async () => {
        expect.assertions(3);

        const mock = createMockClient({ fetchOpenRpc: () => SPEC_WITH_METHODS });

        render(renderPanel(mock));

        await expect(screen.findByTestId("api-reference")).resolves.toBeDefined();
        // The method appears in the nav and its request-argument table renders.
        expect(screen.getByTestId("api-nav-messages:list")).toBeDefined();
        expect(screen.getByTestId("api-operation-args")).toBeDefined();
    });

    it("offers a copy-paste request sample for the selected method", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenRpc: () => SPEC_WITH_METHODS });

        render(renderPanel(mock));

        const sample = await screen.findByTestId("api-sample-source");

        // The default (cURL) sample posts the RPC envelope for this function.
        expect(sample.textContent).toContain("messages:list");
    });

    it("renders an inline spec directly without fetching", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_METHODS));

        await expect(screen.findByTestId("api-reference")).resolves.toBeDefined();
        expect(mock.fetchOpenRpc).not.toHaveBeenCalled();
    });

    it("shows the not-configured empty state for a methodless spec", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenRpc: () => EMPTY_SPEC });

        render(renderPanel(mock));

        await expect(screen.findByTestId("openrpc-reference-empty")).resolves.toBeDefined();
    });

    it("shows an error state when the fetch fails", async () => {
        expect.hasAssertions();

        const mock = createMockClient();

        mock.fetchOpenRpc.mockRejectedValueOnce(new Error("403 forbidden"));

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("openrpc-reference-error")).toBeDefined();
        });
    });
});
