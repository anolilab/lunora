import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PermissionsPanel } from "../../../src/features/permissions/permissions-panel";
import type { AdvisoriesResult, MaskPoliciesResult, RlsPoliciesResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { FunctionDescriptor } from "../../../src/lib/types";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * Codegen reports policy metadata as the two halves it knows — `{ file,
 * procedure }` — never as a joined path. The registry, meanwhile, is keyed on
 * `<file>:<function>`. Fixtures here keep the two deliberately DIFFERENT strings
 * (`documents` + `list` → `documents:list`) so a prefill that forwards only the
 * export name is visible: with a single-element function list a `<select>` whose
 * value matches no option still renders the first one, so the UI looks right
 * while the probe dispatches something the registry has never heard of.
 */
const RLS: RlsPoliciesResult = {
    policies: [{ file: "documents", on: "read", procedure: "list", table: "documents" }],
    roles: [],
};

const FUNCTIONS: FunctionDescriptor[] = [{ args: [], kind: "query", path: "documents:list" }];

/** The generated registry dispatcher: an unregistered path is not a policy verdict, it is an error. */
const createPanelClient = (): MockClientHooks =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.rlsPolicies) {
                return RLS;
            }

            if (reference === ADMIN_FUNCTIONS.maskPolicies) {
                return { columns: [] } satisfies MaskPoliciesResult;
            }

            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return { advisories: [] } satisfies AdvisoriesResult;
            }

            const { functionPath } = args as { functionPath?: unknown };

            if (functionPath !== "documents:list") {
                throw new Error(`unknown function: ${String(functionPath)}`);
            }

            return [{ _id: "doc_1" }];
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <PermissionsPanel functions={FUNCTIONS} runAsIdentity />
    </LunoraProvider>
);

describe("permissionsPanel", () => {
    it("seeds the probe with the covering procedure's registry path, not its export name", async () => {
        expect.assertions(3);

        const mock = createPanelClient();

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("pm-probe-documents-read"));

        // The select's value is the weakest possible signal here — React falls back
        // to the first option when the value matches none — so assert on what the
        // dispatch actually carried.
        const select = await screen.findByTestId<HTMLSelectElement>("pp-function");

        expect(select.value).toBe("documents:list");

        fireEvent.change(screen.getByTestId("pp-user"), { target: { value: "user_1" } });
        fireEvent.click(screen.getByTestId("pp-run"));

        const allowed = await screen.findByTestId("pp-outcome-allowed");

        expect(allowed.textContent).toContain("Allowed");

        const dispatched = mock.query.mock.calls.map((call) => (call[1] as { functionPath?: unknown }).functionPath).filter((path) => path !== undefined);

        expect(dispatched).toEqual(["documents:list"]);
    });
});
