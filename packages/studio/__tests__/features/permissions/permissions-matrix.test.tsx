import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PermissionsMatrix } from "../../../src/features/permissions/permissions-matrix";
import type { AdvisoriesResult, MaskPoliciesResult, RlsOperation, RlsPoliciesResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const RLS: RlsPoliciesResult = {
    policies: [
        { file: "documents", on: "read", procedure: "listDocuments", table: "documents" },
        { file: "documents", on: "update", procedure: "patchDocument", table: "documents" },
    ],
    roles: [],
};

const MASKS: MaskPoliciesResult = {
    columns: [{ column: "ssn", strategy: "redact", table: "documents" }],
};

const ADVISORIES: AdvisoriesResult = {
    advisories: [
        {
            cacheKey: "rls_uncovered_table:notes:listNotes:notes",
            categories: ["SECURITY"],
            description: "uncovered",
            detail: "notes is reachable without a policy",
            facing: "EXTERNAL",
            level: "WARN",
            metadata: { table: "notes" },
            name: "rls_uncovered_table",
            remediation: "add rls",
            title: "uncovered",
        },
    ],
};

/** A client whose three admin queries return the fixtures above. */
const createMatrixClient = (rls: RlsPoliciesResult = RLS): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.rlsPolicies) {
                return rls;
            }

            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return MASKS;
            }

            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return ADVISORIES;
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

const renderMatrix = (mock: MockClientHooks, onProbe?: (table: string, operation: RlsOperation, procedure: string) => void): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <PermissionsMatrix onProbe={onProbe} />
    </LunoraProvider>
);

describe("permissionsMatrix", () => {
    it("renders a covered cell with the procedure and masked columns", async () => {
        expect.assertions(3);

        render(renderMatrix(createMatrixClient()));

        const readCell = await screen.findByTestId("pm-cell-documents-read");

        // The read operation is covered by listDocuments.
        expect(readCell.textContent).toContain("listDocuments");

        const updateCell = screen.getByTestId("pm-cell-documents-update");

        expect(updateCell.textContent).toContain("patchDocument");

        // The masked SSN column is overlaid on the documents row.
        const row = screen.getByTestId("pm-row-documents");

        expect(within(row).getByText("ssn")).toBeDefined();
    });

    it("marks an uncovered table flagged by the advisor", async () => {
        expect.assertions(2);

        render(renderMatrix(createMatrixClient()));

        // The advisor flags `notes` as reachable without a policy.
        const marker = await screen.findByTestId("pm-uncovered-notes");

        expect(marker.textContent).toContain("Uncovered");

        // An uncovered cell shows "No policy".
        const cell = screen.getByTestId("pm-cell-notes-read");

        expect(cell.textContent).toContain("No policy");
    });

    it("shows the empty state when no tables are configured", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.rlsPolicies) {
                    return { policies: [], roles: [] } satisfies RlsPoliciesResult;
                }

                return { advisories: [], columns: [] };
            },
        });

        render(renderMatrix(mock));

        await waitFor(() => {
            expect(screen.getByTestId("pm-empty")).toBeDefined();
        });
    });
});
