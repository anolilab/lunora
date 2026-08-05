import { LunoraProvider } from "@lunora/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApiDocsPanel, {
    buildClientSnippet,
    buildCliSnippet,
    buildReactSnippet,
    buildTableSnippet,
    REACT_HAS_ACTION_HOOK,
    splitPath,
} from "../../../src/features/api/api-docs-panel";
import type { FunctionDescriptor } from "../../../src/index";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const FUNCTIONS: FunctionDescriptor[] = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
    { kind: "action", path: "stripe:sync" },
];

const TABLES = [
    { name: "messages", rowCount: 3 },
    { name: "users", rowCount: 1 },
];

const createClient = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return TABLES;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <ApiDocsPanel functions={FUNCTIONS} />
    </LunoraProvider>
);

describe("snippet builders", () => {
    it("splits a <file>:<fn> path, tolerating a missing colon", () => {
        expect.assertions(2);

        expect(splitPath("messages:list")).toStrictEqual({ file: "messages", fn: "list" });
        expect(splitPath("bare")).toStrictEqual({ file: "", fn: "bare" });
    });

    it("builds the React hook snippet per kind", () => {
        expect.assertions(3);

        expect(buildReactSnippet({ file: "messages", fn: "list", kind: "query" })).toBe("const data = useQuery(api.messages.list, { /* args */ });");
        expect(buildReactSnippet({ file: "messages", fn: "send", kind: "mutation" })).toBe("const send = useMutation(api.messages.send);");
        // Actions have no React hook, so the React tab falls back to the client snippet.
        expect(buildReactSnippet({ file: "stripe", fn: "sync", kind: "action" })).toBe(buildClientSnippet({ file: "stripe", fn: "sync", kind: "action" }));
    });

    it("documents that actions have no React hook", () => {
        expect.assertions(1);

        expect(REACT_HAS_ACTION_HOOK).toBe(false);
    });

    it("builds the client SDK snippet per kind", () => {
        expect.assertions(3);

        expect(buildClientSnippet({ file: "messages", fn: "list", kind: "query" })).toBe("await client.query(api.messages.list, { /* args */ });");
        expect(buildClientSnippet({ file: "messages", fn: "send", kind: "mutation" })).toBe("await client.mutation(api.messages.send, { /* args */ });");
        expect(buildClientSnippet({ file: "stripe", fn: "sync", kind: "action" })).toBe("await client.action(api.stripe.sync, { /* args */ });");
    });

    it("builds the CLI snippet", () => {
        expect.assertions(1);

        expect(buildCliSnippet({ file: "messages", fn: "list", kind: "query" })).toBe("lunora run messages:list --args '{ }'");
    });

    it("builds the typed data-model snippet for a table", () => {
        expect.assertions(4);

        const snippet = buildTableSnippet("messages");

        expect(snippet).toContain('ctx.db.query("messages")');
        expect(snippet).toContain('ctx.db.insert("messages", { /* fields */ })');
        expect(snippet).toContain('Doc<"messages">');
        expect(snippet).toContain('Id<"messages">');
    });
});

describe("apiDocsPanel", () => {
    let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

    beforeEach(() => {
        writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
        Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("lists functions grouped by file and a Tables section", async () => {
        expect.assertions(4);

        render(renderPanel(createClient()));

        // Function rail entries are grouped by file.
        expect(screen.getByTestId("api-rail-fn-messages:list")).toBeDefined();
        expect(screen.getByTestId("api-rail-fn-messages:send")).toBeDefined();
        expect(screen.getByTestId("api-rail-fn-stripe:sync")).toBeDefined();

        // Tables load asynchronously via listTables.
        const tableEntry = await screen.findByTestId("api-rail-table-messages");

        expect(tableEntry).toBeDefined();
    });

    it("shows React, Client, and CLI snippets for a selected query", async () => {
        expect.assertions(3);

        render(renderPanel(createClient()));

        // Flush the listTables effect's state update inside an act scope.
        await act(async () => {
            await Promise.resolve();
        });

        fireEvent.click(screen.getByTestId("api-rail-fn-messages:list"));

        // React tab is the default.
        expect(screen.getByTestId("api-snippet-react").textContent).toContain("useQuery(api.messages.list");

        fireEvent.click(screen.getByTestId("api-tab-client"));

        expect(screen.getByTestId("api-snippet-client").textContent).toContain("await client.query(api.messages.list");

        fireEvent.click(screen.getByTestId("api-tab-cli"));

        expect(screen.getByTestId("api-snippet-cli").textContent).toContain("lunora run messages:list --args");
    });

    it("notes the action fallback on the React tab", () => {
        expect.assertions(2);

        render(renderPanel(createClient()));

        fireEvent.click(screen.getByTestId("api-rail-fn-stripe:sync"));

        // React tab for an action shows the client call plus the explanatory note.
        expect(screen.getByTestId("api-snippet-react").textContent).toContain("await client.action(api.stripe.sync");
        expect(screen.getByTestId("api-action-note")).toBeDefined();
    });

    it("shows the typed data-model snippet for a selected table", async () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        fireEvent.click(await screen.findByTestId("api-rail-table-messages"));

        expect(screen.getByTestId("api-snippet-table").textContent).toContain('ctx.db.query("messages")');
    });

    it("copies a snippet to the clipboard via the Copy button", () => {
        expect.assertions(1);

        render(renderPanel(createClient()));

        fireEvent.click(screen.getByTestId("api-rail-fn-messages:list"));
        fireEvent.click(screen.getByTestId("api-snippet-react-copy"));

        expect(writeText).toHaveBeenCalledWith("const data = useQuery(api.messages.list, { /* args */ });");
    });
});
