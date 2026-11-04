import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdvisorHealthPanel from "../../../src/features/advisors/advisor-health-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

/**
 * The panel under a mock client whose only admin read is the (empty) advisory list.
 * `token` is the admin bearer the client carries (the mock's default is a non-empty one);
 * `null` models a client with no credential.
 */
const renderPanel = (localProcedures: boolean, token: null | string = null, advisorCompanion = true): ReactElement => (
    <LunoraProvider
        client={Object.assign(
            createMockClient({
                query: (reference): unknown => {
                    if (reference === ADMIN_FUNCTIONS.getAdvisories) {
                        return { advisories: [] };
                    }

                    throw new Error(`unexpected query: ${reference}`);
                },
            }).asClient,
            { getAuthToken: () => token },
        )}
    >
        <AdvisorHealthPanel advisorCompanion={advisorCompanion} localProcedures={localProcedures} />
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
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false));

        const notice = await screen.findByTestId("advisor-health-local-only");

        expect(notice.textContent).toContain("lunora dev");
        expect(fetchMock).not.toHaveBeenCalled();
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

    it("sends no request when the worker has no companion, even with a token", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false, "test-token", false));

        const notice = await screen.findByTestId("advisor-health-local-only");

        expect(notice.textContent).toContain("VITE_LUNORA_ADVISOR_COMPANION");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetches the list from the configured worker with the admin bearer and scores it", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false, "test-token"));

        const score = await screen.findByTestId("advisor-health-score");

        expect(score.textContent).toMatch(/^\d+$/);
        expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/__lunora/advisor-procedures", { headers: { authorization: "Bearer test-token" } });
    });

    it("says the companion is not deployed when the configured worker answers 404", async () => {
        expect.assertions(2);

        stubProceduresResponse(404, { error: "not found" });

        render(renderPanel(false, "test-token"));

        const notice = await screen.findByTestId("advisor-health-companion-missing");

        expect(notice.textContent).toContain("companion");
        expect(screen.queryByTestId("advisor-health-error")).toBeNull();
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
