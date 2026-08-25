import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { AssistantProvider, useAssistant } from "../../../src/components/assistant-provider";
import RlsPanel from "../../../src/features/advisors/rls-panel";
import type { RlsPoliciesResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const METADATA: RlsPoliciesResult = {
    policies: [
        { file: "documents", on: "read", procedure: "listDocuments", table: "documents" },
        { file: "documents", on: "update", procedure: "patchDocument", table: "documents" },
        { file: "posts", on: "delete", procedure: "removePost", table: "posts" },
    ],
    roles: [
        { description: "Full access", name: "admin", permissions: ["documents:delete", "posts:delete"] },
        { name: "viewer", permissions: [] },
    ],
};

/** A client whose `rlsPolicies` admin query returns the fixed metadata above. */
const createRlsClient = (result: RlsPoliciesResult = METADATA): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.rlsPolicies) {
                return result;
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <RlsPanel />
    </LunoraProvider>
);

/** Renders whatever question the panel seeded, so a test can read it out of the DOM. */
const AskProbe = (): ReactElement => <span data-testid="seeded-ask">{useAssistant()?.pendingAsk?.text ?? ""}</span>;

/**
 * The panel under a mounted assistant that reports itself available.
 *
 * `aiAvailable` is asked by the provider on the ROOT shard, so the mock answers
 * both references — a query double that only knew `rlsPolicies` would latch the
 * assistant unavailable and hide the very control under test.
 */
const renderWithAssistant = (result: RlsPoliciesResult = METADATA): ReactElement => (
    <LunoraProvider
        client={
            createMockClient({
                query: (reference): unknown => (reference === ADMIN_FUNCTIONS.rlsPolicies ? result : { available: true, level: "schema" }),
            }).asClient
        }
    >
        <AssistantProvider>
            <RlsPanel />
            <AskProbe />
        </AssistantProvider>
    </LunoraProvider>
);

describe("rlsPanel", () => {
    it("groups policies by table and marks the guarded operations", async () => {
        expect.assertions(4);

        render(renderPanel(createRlsClient()));

        const documentsRow = await screen.findByTestId("rls-table-documents");

        // The documents table is guarded on read + update (2 "Guarded" badges),
        // and names the procedures that declared the policies.
        expect(within(documentsRow).getAllByText("Guarded")).toHaveLength(2);
        expect(documentsRow.textContent).toContain("listDocuments");
        expect(documentsRow.textContent).toContain("patchDocument");

        const postsRow = screen.getByTestId("rls-table-posts");

        // The posts table is guarded only on delete (1 badge).
        expect(within(postsRow).getAllByText("Guarded")).toHaveLength(1);
    });

    it("lists every role with its description and permissions", async () => {
        expect.assertions(3);

        render(renderPanel(createRlsClient()));

        const adminRow = await screen.findByTestId("rls-role-admin");

        expect(adminRow.textContent).toContain("Full access");
        expect(adminRow.textContent).toContain("documents:delete");

        // The viewer role grants no permissions, rendering the em-dash placeholder.
        const viewerRow = screen.getByTestId("rls-role-viewer");

        expect(viewerRow.textContent).toContain("viewer");
    });

    it("shows empty states when no policies or roles are defined", async () => {
        expect.hasAssertions();

        render(renderPanel(createRlsClient({ policies: [], roles: [] })));

        await waitFor(() => {
            expect(screen.getByTestId("rls-policies-empty").textContent).toContain("No policies defined");
        });

        expect(screen.getByTestId("rls-roles-empty").textContent).toContain("No roles defined");
    });

    it("surfaces a load error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (): unknown => {
                throw new Error("admin gate closed");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("rls-error");

        expect(error.textContent).toContain("admin gate closed");
    });
});

/**
 * The proposal path, and its boundary.
 *
 * RLS here is TypeScript, not DDL: there is no statement to run and no admin op
 * that could apply a policy — only the loopback dev host's scaffolder writes one.
 * So the assistant is opened on what this panel is SHOWING and answers with
 * source; nothing on this page applies it.
 */
describe("rlsPanel — asking the assistant", () => {
    it("seeds the coverage on screen rather than making the model re-derive it", async () => {
        expect.hasAssertions();

        render(renderWithAssistant());

        fireEvent.click(await screen.findByTestId("rls-ask-assistant"));

        const seeded = screen.getByTestId("seeded-ask").textContent ?? "";

        // What the operator is looking at travels verbatim — the same reason an
        // advisor finding does — so the turn does not spend a round of its tool
        // budget reading back what the panel already has.
        expect(seeded).toContain("documents: read/update");
        expect(seeded).toContain("posts: delete");
    });

    it("asks about the gap rather than the coverage when nothing is declared", async () => {
        expect.hasAssertions();

        render(renderWithAssistant({ policies: [], roles: [] }));

        fireEvent.click(await screen.findByTestId("rls-ask-assistant"));

        // The most important case is the one with no row to click: a deployment
        // with no policies at all still gets a way in.
        expect(screen.getByTestId("seeded-ask").textContent).toContain("no row-level-security policies at all");
    });

    it("offers nothing when no assistant is mounted above it", async () => {
        expect.hasAssertions();

        // `useAssistant` answers `undefined` outside a provider, and the contract is
        // to render no control rather than a dead one — a bare-composed Studio panel
        // must not grow a button that silently does nothing.
        render(renderPanel(createRlsClient()));

        await screen.findByTestId("rls-policies-table");

        expect(screen.queryByTestId("rls-ask-assistant")).toBeNull();
    });
});
