import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdvisorHealthPanel from "../../../src/features/advisors/advisor-health-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

/** The panel under a mock client whose only admin read is the (empty) advisory list. */
const renderPanel = (localProcedures: boolean): ReactElement => (
    <LunoraProvider
        client={
            createMockClient({
                query: (reference): unknown => {
                    if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                        return { advisories: [] };
                    }

                    throw new Error(`unexpected query: ${reference}`);
                },
            }).asClient
        }
    >
        <AdvisorHealthPanel localProcedures={localProcedures} />
    </LunoraProvider>
);

const stubProceduresResponse = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => Response.json(body, { status }));

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

describe("advisorHealthPanel", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not request the procedure list on a host that cannot serve it, and says why", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false));

        await expect(screen.findByTestId("advisor-health-local-only")).resolves.toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("scores the deployment when the dev host serves the procedure list", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(true));

        await expect(screen.findByTestId("advisor-health-score")).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith("/__lunora/advisor-procedures");
    });

    it("shows the host's reason when the dev host has no generated list yet", async () => {
        expect.assertions(2);

        stubProceduresResponse(404, { error: "advisor-procedures.json is not generated yet; run `lunora codegen`." });

        render(renderPanel(true));

        const alert = await screen.findByTestId("advisor-health-error");

        expect(alert.textContent).toContain("lunora codegen");

        await waitFor(() => {
            expect(screen.queryByTestId("advisor-health-score")).toBeNull();
        });
    });
});
