import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionsPanel } from "../../../src/features/permissions/permissions-panel";
import PolicyScaffolder from "../../../src/features/permissions/policy-scaffolder";
import type { AdvisoriesResult, MaskPoliciesResult, RlsPoliciesResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { FunctionDescriptor } from "../../../src/lib/types";
import { createMockClient } from "../../mock-client";

const EMPTY_RLS: RlsPoliciesResult = { policies: [], roles: [] };
const EMPTY_MASKS: MaskPoliciesResult = { columns: [] };
const EMPTY_ADVISORIES: AdvisoriesResult = { advisories: [] };
const NO_FUNCTIONS: FunctionDescriptor[] = [];

/** A client whose three admin queries resolve to empty fixtures (matrix renders, no rows). */
const createPanelClient = (): ReturnType<typeof createMockClient> =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.rlsPolicies) {
                return EMPTY_RLS;
            }

            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return EMPTY_MASKS;
            }

            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return EMPTY_ADVISORIES;
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

describe("policyScaffolder", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("scaffolds a new policy file and surfaces the success notice", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<(input: string, init: { body: string; method: string }) => Promise<unknown>>().mockResolvedValue({
            json: async () => {
                return { diagnostics: [], fileName: "invoices.policies.ts", ok: true };
            },
            ok: true,
            status: 200,
        });

        vi.stubGlobal("fetch", fetchMock);

        render(<PolicyScaffolder />);

        fireEvent.click(screen.getByTestId("policy-scaffolder-new"));
        fireEvent.change(screen.getByTestId("policy-scaffolder-name"), { target: { value: "invoices" } });
        fireEvent.change(screen.getByTestId("policy-scaffolder-table"), { target: { value: "invoices" } });
        fireEvent.click(screen.getByTestId("policy-scaffolder-create"));

        await screen.findByTestId("policy-scaffolder-ok");

        expect(fetchMock).toHaveBeenCalledWith("/__lunora/policy-scaffold", expect.objectContaining({ method: "POST" }));

        const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];

        expect(JSON.parse(init.body)).toStrictEqual({ kind: "scaffoldPolicy", name: "invoices", table: "invoices" });
        expect(screen.getByTestId("policy-scaffolder-ok").textContent).toContain("invoices.policies.ts");
    });

    it("renders the scaffolder only when schemaEditable is set", async () => {
        expect.hasAssertions();

        const { rerender } = render(
            <LunoraProvider client={createPanelClient().asClient}>
                <PermissionsPanel functions={NO_FUNCTIONS} schemaEditable={false} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.queryByTestId("policy-scaffolder")).toBeNull();
        });

        rerender(
            <LunoraProvider client={createPanelClient().asClient}>
                <PermissionsPanel functions={NO_FUNCTIONS} schemaEditable />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("policy-scaffolder")).toBeDefined();
        });
    });
});
