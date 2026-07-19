import type { VectorIndexSummary, VectorQueryMatch } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { VectorBrowser } from "../../../src/features/vectors/vector-browser";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const INDEXES: VectorIndexSummary[] = [
    { dimensions: 1024, field: "body", metadata: ["title"], metric: "cosine", name: "by_body", table: "docs", vectorsCount: 42 },
    { dimensions: 768, name: "abstracts", table: "papers" },
];

const MATCHES: VectorQueryMatch[] = [{ id: "row-1", metadata: { title: "hi" }, score: 0.91 }];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

const loadIndexes = async (): Promise<VectorIndexSummary[]> => INDEXES;
const loadEmpty = async (): Promise<VectorIndexSummary[]> => [];

describe("vectorBrowser", () => {
    it("lists indexes with their declared shape and live stats", async () => {
        expect.assertions(3);

        render(withProvider(createMockClient(), <VectorBrowser loadIndexes={loadIndexes} />));

        await screen.findByTestId("vector-table");

        expect(screen.getByTestId("vector-row-by_body")).toBeDefined();
        // "cosine" / "42" render in both the table row and the detail panel.
        expect(screen.getAllByText("cosine").length).toBeGreaterThan(0);
        expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    });

    it("shows the empty state when there are no indexes", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <VectorBrowser loadIndexes={loadEmpty} />));

        const empty = await screen.findByTestId("vector-empty");

        expect(empty).toBeDefined();
    });

    it("runs a similarity query and renders the matches", async () => {
        expect.assertions(3);

        const runQuery = vi.fn<(options: { name: string; text: string; topK?: number }) => Promise<VectorQueryMatch[]>>(async () => MATCHES);

        render(withProvider(createMockClient(), <VectorBrowser loadIndexes={loadIndexes} runQuery={runQuery} />));

        await screen.findByTestId("vector-detail");

        fireEvent.change(screen.getByTestId("vector-query-input"), { target: { value: "hello" } });
        fireEvent.click(screen.getByTestId("vector-search"));

        await screen.findByTestId("vector-matches");

        expect(screen.getByTestId("vector-match-row-1")).toBeDefined();
        expect(screen.getByText("0.9100")).toBeDefined();
        expect(runQuery).toHaveBeenCalledWith({ name: "by_body", text: "hello", topK: 10 });
    });

    it("surfaces a query error (e.g. no embedder wired)", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<(options: { name: string; text: string; topK?: number }) => Promise<VectorQueryMatch[]>>(async () => {
            throw new Error("VECTOR_QUERY_UNSUPPORTED");
        });

        render(withProvider(createMockClient(), <VectorBrowser loadIndexes={loadIndexes} runQuery={runQuery} />));

        await screen.findByTestId("vector-detail");

        fireEvent.change(screen.getByTestId("vector-query-input"), { target: { value: "hi" } });
        fireEvent.click(screen.getByTestId("vector-search"));

        await waitFor(() => {
            expect(screen.getByTestId("vector-query-error").textContent).toContain("VECTOR_QUERY_UNSUPPORTED");
        });
    });

    it("falls back to the client when no loader is supplied", async () => {
        expect.assertions(1);

        const mock = createMockClient({ listVectorIndexes: () => INDEXES });

        render(withProvider(mock, <VectorBrowser />));

        await screen.findByTestId("vector-table");

        expect(mock.listVectorIndexes).toHaveBeenCalledTimes(1);
    });
});
