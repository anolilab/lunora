import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdvisorHealthPanel from "../../../src/features/advisors/advisor-health-panel";
import type { AdvisoryFinding } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

/**
 * The panel under a mock client whose only admin read is the (empty) advisory list.
 * `token` is the admin bearer the client carries (the mock's default is a non-empty one);
 * `null` models a client with no credential.
 */
const defaultQuery = (reference: string): unknown => {
    if (reference === ADMIN_FUNCTIONS.getAdvisories) {
        return { advisories: [] };
    }

    throw new Error(`unexpected query: ${reference}`);
};

/** The mock client the last `renderPanel` built, so a case can assert its admin reads or push a live value. */
let lastClient: ReturnType<typeof createMockClient> | undefined;
/** The `query` mock the last `renderPanel` built, so a case can assert which admin reads were issued. */
let queryMock: ReturnType<typeof vi.fn> | undefined;

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

const renderPanel = (localProcedures: boolean, token: null | string = null, advisorCompanion = true, query = defaultQuery): ReactElement => {
    const client = createMockClient({ query });

    lastClient = client;
    queryMock = client.query;

    return (
        <LunoraProvider client={Object.assign(client.asClient, { getAuthToken: () => token })}>
            <AdvisorHealthPanel advisorCompanion={advisorCompanion} localProcedures={localProcedures} />
        </LunoraProvider>
    );
};

const stubProceduresResponse = (status: number, body: unknown) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body, { status }));

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

describe("advisorHealthPanel", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not request the procedure list or the advisories on a host that cannot serve them, and says why", async () => {
        expect.assertions(3);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false, null, false));

        const notice = await screen.findByTestId("advisor-health-local-only");

        expect(notice.textContent).toContain("lunora dev");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
    });

    it("fetches the procedure list again when the live advisories change", async () => {
        expect.hasAssertions();

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(true));

        await screen.findByTestId("advisor-health-score");

        // A different list: React Query keeps the old reference for deep-equal data, which is no change.
        lastClient?.emit(ADMIN_FUNCTIONS.getAdvisories, { advisories: [NEW_FINDING] });

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it("keeps the last score on screen while the list for new advisories loads", async () => {
        expect.hasAssertions();

        const second = Promise.withResolvers<Response>();
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(Response.json({ procedures: [] }))
            .mockReturnValueOnce(second.promise);

        vi.stubGlobal("fetch", fetchMock);
        render(renderPanel(true));

        const score = await screen.findByTestId("advisor-health-score");
        const before = score.textContent;

        lastClient?.emit(ADMIN_FUNCTIONS.getAdvisories, { advisories: [NEW_FINDING] });

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        expect(screen.queryByTestId("advisor-health-loading")).toBeNull();
        expect(screen.getByTestId("advisor-health-score").textContent).toBe(before);

        second.resolve(Response.json({ procedures: [] }));
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
        expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/__lunora/advisor-procedures", {
            credentials: "include",
            headers: { authorization: "Bearer test-token" },
        });
    });

    it("asks the worker on the session cookie alone when the client holds no bearer", async () => {
        expect.assertions(2);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });

        render(renderPanel(false, null));

        await screen.findByTestId("advisor-health-score");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/__lunora/advisor-procedures", { credentials: "include", headers: {} });
    });

    it("reports a response without a procedure list instead of loading forever", async () => {
        expect.assertions(1);

        stubProceduresResponse(200, {});

        render(renderPanel(true));

        const alert = await screen.findByTestId("advisor-health-error");

        expect(alert.textContent).toContain("without a procedure list");
    });

    it("says the companion is not deployed when the configured worker answers 404", async () => {
        expect.assertions(2);

        stubProceduresResponse(404, { error: "not found" });

        render(renderPanel(false, "test-token"));

        const notice = await screen.findByTestId("advisor-health-companion-missing");

        expect(notice.textContent).toContain("companion");
        expect(screen.queryByTestId("advisor-health-error")).toBeNull();
    });

    it("says the analysis was disabled instead of scoring an empty roster", async () => {
        expect.assertions(2);

        stubProceduresResponse(200, { analysis: "disabled", procedures: [] });

        render(renderPanel(true));

        const notice = await screen.findByTestId("advisor-health-lint-disabled");

        expect(notice.textContent).toContain("lint: false");
        expect(screen.queryByTestId("advisor-health-score")).toBeNull();
    });

    it("re-reads the list on remount instead of serving the cached roster", async () => {
        expect.assertions(1);

        const fetchMock = stubProceduresResponse(200, { procedures: [] });
        const client = Object.assign(createMockClient({ query: defaultQuery }).asClient, { getAuthToken: () => null });
        const panel = (show: boolean): ReactElement => <LunoraProvider client={client}>{show ? <AdvisorHealthPanel localProcedures /> : null}</LunoraProvider>;

        const view = render(panel(true));

        await screen.findByTestId("advisor-health-score");

        view.rerender(panel(false));
        view.rerender(panel(true));

        // The generated roster changes without its query key changing, so a remount must not
        // serve the previous mount's cache indefinitely (`staleTime: 0`).
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2);
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
