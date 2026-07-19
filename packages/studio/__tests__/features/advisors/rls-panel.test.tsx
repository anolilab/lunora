import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

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
