import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdvisorHealthPanel from "../../../src/features/advisors/advisor-health-panel";
import type { AdvisoryFinding } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

/** A mock client whose only admin read is the (empty) advisory list. */
const createAdvisoriesClient = () =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                return { advisories: [] };
            }

            throw new Error(`unexpected query: ${reference}`);
        },
    });

const NEW_FINDING: AdvisoryFinding = {
    cacheKey: "unindexed_foreign_key:todos",
    categories: ["PERFORMANCE"],
    description: "",
    detail: "",
    facing: "INTERNAL",
    level: "WARN",
    metadata: {},
    name: "unindexed_foreign_key",
    remediation: "",
    title: "Unindexed foreign key",
};

const renderPanel = (localProcedures: boolean, mock = createAdvisoriesClient()): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <AdvisorHealthPanel localProcedures={localProcedures} />
    </LunoraProvider>
);

const stubProceduresResponse = (status: number, body: unknown) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body, { status }));

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

describe("advisorHealthPanel", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not request the procedure list on a host that cannot serve it, and says why", async () => {
        expect.assertions(3);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        const mock = createAdvisoriesClient();

        render(renderPanel(false, mock));

        const notice = await screen.findByTestId("advisor-health-local-only");

        expect(notice.textContent).toContain("lunora dev");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
    });

    it("fetches the procedure list again when the live advisories change", async () => {
        expect.hasAssertions();

        const fetchMock = stubProceduresResponse(200, { procedures: [] });
        const mock = createAdvisoriesClient();

        render(renderPanel(true, mock));

        await screen.findByTestId("advisor-health-score");

        // A different list: React Query keeps the old reference for deep-equal data, which is no change.
        mock.emit(ADMIN_FUNCTIONS.getAdvisories, { advisories: [NEW_FINDING] });

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it("scores the deployment when the dev host serves the procedure list", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(true));

        const score = await screen.findByTestId("advisor-health-score");

        expect(score.textContent).toMatch(/^\d+$/);
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

    it("fetches the list once when the advisories arrive after the first request", async () => {
        expect.assertions(1);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(true));
        await screen.findByTestId("advisor-health-score");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports a failing list at once instead of retrying behind a loading state", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(500, { error: "advisor-procedures.json is not valid JSON; re-run `lunora codegen`." });

        render(renderPanel(true));
        await screen.findByTestId("advisor-health-error");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("advisor-health-loading")).toBeNull();
    });

    it("says the route is missing when the host answers the SPA shell with 200", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" }, status: 200 })),
        );

        render(renderPanel(true));

        const alert = await screen.findByTestId("advisor-health-error");

        expect(alert.textContent).toContain("not available on this host");
    });
});
