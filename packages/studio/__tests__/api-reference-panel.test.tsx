import { CirrusProvider } from "@cirrus/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import ApiReferencePanel from "../src/api-reference-panel.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

// Scalar's React component pulls in the full API-client app (workspace store,
// CodeMirror, Vue bundle) which neither needs nor works under jsdom. Stub it with
// a marker that echoes whether it received a spec, so the panel's state machine
// (loading → ready/empty/error) is what's under test, not Scalar's internals.
// eslint-disable-next-line vitest/prefer-import-in-mock -- the typed `import()` form requires the factory to match Scalar's full module shape (type re-exports + the real prop type); the string form lets the stub expose only what the panel reads
vi.mock("@scalar/api-reference-react", () => {
    const ApiReferenceReact = ({ configuration }: { configuration: { content?: unknown } }): ReactElement => (
        <div data-has-content={configuration.content === undefined ? "no" : "yes"} data-testid="scalar-stub" />
    );

    return { ApiReferenceReact };
});

const SPEC_WITH_PATHS: Record<string, unknown> = {
    info: { title: "Cirrus API", version: "1.0.0" },
    openapi: "3.1.0",
    paths: { "/_cirrus/rpc#messages:list": { post: { operationId: "messages:list" } } },
};

const EMPTY_SPEC: Record<string, unknown> = { info: { title: "Cirrus API", version: "0.0.0" }, openapi: "3.1.0", paths: {} };

const renderPanel = (mock: MockClientHooks, spec?: unknown): ReactElement => (
    <CirrusProvider client={mock.asClient}>
        <ApiReferencePanel spec={spec} />
    </CirrusProvider>
);

describe("apiReferencePanel", () => {
    it("renders Scalar over a spec fetched from the worker", async () => {
        expect.assertions(2);

        const mock = createMockClient({ fetchOpenApi: () => SPEC_WITH_PATHS });

        render(renderPanel(mock));

        const stub = await screen.findByTestId("scalar-stub");

        expect(stub).toBeDefined();
        // The fetched spec is handed to Scalar as `content`.
        expect(stub.dataset.hasContent).toBe("yes");
    });

    it("renders an inline spec directly without fetching", async () => {
        expect.assertions(2);

        const mock = createMockClient();

        render(renderPanel(mock, SPEC_WITH_PATHS));

        await expect(screen.findByTestId("scalar-stub")).resolves.toBeDefined();
        // The inline path never hits the client's fetch accessor.
        expect(mock.fetchOpenApi).not.toHaveBeenCalled();
    });

    it("shows the not-configured empty state for a pathless spec", async () => {
        expect.assertions(1);

        const mock = createMockClient({ fetchOpenApi: () => EMPTY_SPEC });

        render(renderPanel(mock));

        await expect(screen.findByTestId("api-reference-empty")).resolves.toBeDefined();
    });

    it("shows an error state when the fetch fails", async () => {
        expect.assertions(1);

        const mock = createMockClient();

        mock.fetchOpenApi.mockRejectedValueOnce(new Error("403 forbidden"));

        render(renderPanel(mock));

        await waitFor(() => {
            expect(screen.getByTestId("api-reference-error")).toBeDefined();
        });
    });
});
