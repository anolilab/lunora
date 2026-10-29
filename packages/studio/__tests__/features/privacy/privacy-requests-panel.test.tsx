import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RequestStatus } from "../../../../../shared/privacy-request-status";
import { REQUEST_STATUSES } from "../../../../../shared/privacy-request-status";
import { PrivacyRequestsPanel } from "../../../src/features/privacy/privacy-requests-panel";
import type { PrivacyRequestRow, PrivacyRequestsSource } from "../../../src/features/privacy/privacy-requests-source";
import { formatTimestamp } from "../../../src/lib/internal";

type ListFn = PrivacyRequestsSource["listOpenPrivacyRequests"];
type RetryFn = PrivacyRequestsSource["retryPrivacyRequest"];

const DAY = 86_400_000;
const NOW = Date.now();

const PAST_DUE = NOW - 2 * DAY;
const FUTURE_DUE = NOW + 5 * DAY;
const EXTENDED_DUE = NOW + 20 * DAY;

const openRequest: PrivacyRequestRow = {
    dueAt: FUTURE_DUE,
    id: "req_open",
    receivedAt: NOW - DAY,
    status: "received",
    subjectId: "user_open",
    type: "export",
};

const overdueFailed: PrivacyRequestRow = {
    dueAt: PAST_DUE,
    id: "req_failed",
    receivedAt: NOW - 30 * DAY,
    status: "failed",
    subjectId: "user_failed",
    type: "erasure",
};

const extended: PrivacyRequestRow = {
    dueAt: PAST_DUE,
    extendedDueAt: EXTENDED_DUE,
    id: "req_extended",
    receivedAt: NOW - 40 * DAY,
    status: "processing",
    subjectId: "user_extended",
    type: "export",
};

const renderPanel = (source?: PrivacyRequestsSource): ReturnType<typeof render> => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (node: ReactElement): ReactElement => <QueryClientProvider client={client}>{node}</QueryClientProvider>;

    return render(wrap(<PrivacyRequestsPanel source={source} />));
};

const sourceOf = (listOpenPrivacyRequests: ListFn, retryPrivacyRequest: RetryFn = vi.fn<RetryFn>(async () => undefined)): PrivacyRequestsSource => {
    return {
        listOpenPrivacyRequests,
        retryPrivacyRequest,
    };
};

const rowFor = (id: string): HTMLElement => screen.getByRole("row", { name: new RegExp(id) });

describe("privacyRequestsPanel", () => {
    it("renders the not-configured state and makes no request without a source", () => {
        expect.assertions(1);

        renderPanel();

        expect(screen.getByTestId("privacy-requests-not-configured")).toBeDefined();
    });

    it("renders the loading state while the list is pending", () => {
        expect.assertions(1);

        const list = vi.fn<ListFn>(
            () =>
                new Promise<ReadonlyArray<PrivacyRequestRow>>(() => {
                    // Never settles, so the panel stays in its loading state.
                }),
        );

        renderPanel(sourceOf(list));

        expect(screen.getByTestId("privacy-requests-loading")).toBeDefined();
    });

    it("renders the empty state when no requests are open", async () => {
        expect.assertions(1);

        renderPanel(sourceOf(vi.fn<ListFn>(async () => [])));

        await expect(screen.findByTestId("privacy-requests-empty")).resolves.toBeDefined();
    });

    it("renders the server's message in the error state", async () => {
        expect.assertions(2);

        const list = vi.fn<ListFn>(async () => {
            throw new Error("Forbidden: admin token required");
        });

        renderPanel(sourceOf(list));

        const alert = await screen.findByTestId("privacy-requests-error");

        expect(alert).toBeDefined();
        expect(alert.textContent).toContain("Forbidden: admin token required");
    });

    it("renders each field of every row", async () => {
        expect.assertions(8);

        renderPanel(sourceOf(vi.fn<ListFn>(async () => [openRequest])));

        const row = await waitFor(() => rowFor(openRequest.id));
        const cells = within(row).getAllByRole("cell");

        expect(cells[0]?.textContent).toBe("req_open");
        expect(cells[1]?.textContent).toBe("Export");
        expect(cells[2]?.textContent).toBe("user_open");
        expect(cells[3]?.textContent).toBe("received");
        expect(cells[4]?.textContent).toBe(formatTimestamp(openRequest.receivedAt));
        expect(cells[5]?.textContent).toBe(formatTimestamp(openRequest.dueAt));
        expect(cells[6]?.textContent).toBe("—");
        expect(cells[7]?.textContent).toBe("");
    });

    it("flags overdue rows and shows the extended due date when one is set", async () => {
        expect.assertions(5);

        renderPanel(sourceOf(vi.fn<ListFn>(async () => [openRequest, overdueFailed, extended])));

        const overdueRow = await waitFor(() => rowFor(overdueFailed.id));

        expect(overdueRow.dataset.overdue).toBe("true");
        expect(within(overdueRow).getByTestId("privacy-overdue")).toBeDefined();

        // An extended request is judged against its extended date, so it is not overdue.
        const extendedRow = rowFor(extended.id);

        expect(extendedRow.dataset.overdue).toBe("false");
        expect(within(extendedRow).getAllByRole("cell")[6]?.textContent).toBe(formatTimestamp(EXTENDED_DUE));
        expect(rowFor(openRequest.id).dataset.overdue).toBe("false");
    });

    it("shows Retry on a failed row and not on an open row", async () => {
        expect.assertions(2);

        renderPanel(sourceOf(vi.fn<ListFn>(async () => [openRequest, overdueFailed])));

        const failedRow = await waitFor(() => rowFor(overdueFailed.id));

        expect(within(failedRow).getByRole("button", { name: "Retry" })).toBeDefined();
        expect(within(rowFor(openRequest.id)).queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("renders a badge with the status text for every status", async () => {
        expect.hasAssertions();

        const rows: ReadonlyArray<PrivacyRequestRow> = REQUEST_STATUSES.map((status: RequestStatus) => {
            return {
                ...openRequest,
                id: `req_${status}`,
                status,
            };
        });

        renderPanel(sourceOf(vi.fn<ListFn>(async () => rows)));

        const renderedRows = await waitFor(() => {
            const found = screen.getAllByTestId("privacy-request-row");

            expect(found).toHaveLength(REQUEST_STATUSES.length);

            return found;
        });

        expect(renderedRows.map((row) => within(row).getAllByRole("cell")[3]?.textContent)).toEqual(REQUEST_STATUSES);
    });

    it("offers Retry on the failed status only, across every status", async () => {
        expect.assertions(2);

        const rows: ReadonlyArray<PrivacyRequestRow> = REQUEST_STATUSES.map((status: RequestStatus) => {
            return {
                ...openRequest,
                id: `req_${status}`,
                status,
            };
        });

        renderPanel(sourceOf(vi.fn<ListFn>(async () => rows)));

        const failedRow = await waitFor(() => rowFor("req_failed"));

        expect(within(failedRow).getAllByRole("button", { name: "Retry" })).toHaveLength(1);

        const withRetry = screen.getAllByTestId("privacy-request-row").filter((row) => within(row).queryByRole("button", { name: "Retry" }) !== null);

        expect(withRetry.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["req_failed"]);
    });

    it("calls the source on Retry and refreshes the list", async () => {
        expect.hasAssertions();

        // After the retry the server reports the request as open again.
        const list = vi
            .fn<ListFn>(async () => [overdueFailed])
            .mockResolvedValueOnce([overdueFailed])
            .mockResolvedValueOnce([{ ...overdueFailed, status: "received" }]);
        const retry = vi.fn<RetryFn>(async () => undefined);

        renderPanel(sourceOf(list, retry));

        const failedRow = await waitFor(() => rowFor(overdueFailed.id));

        fireEvent.click(within(failedRow).getByRole("button", { name: "Retry" }));

        await waitFor(() => {
            expect(retry).toHaveBeenCalledWith("req_failed");
        });

        await waitFor(() => {
            expect(list).toHaveBeenCalledTimes(2);
        });

        await waitFor(() => {
            expect(within(rowFor(overdueFailed.id)).queryByRole("button", { name: "Retry" })).toBeNull();
        });
    });

    it("shows the server's message when a retry fails", async () => {
        expect.assertions(2);

        const retry = vi.fn<RetryFn>(async () => {
            throw new Error("Request is not in a failed state");
        });

        renderPanel(
            sourceOf(
                vi.fn<ListFn>(async () => [overdueFailed]),
                retry,
            ),
        );

        const failedRow = await waitFor(() => rowFor(overdueFailed.id));

        fireEvent.click(within(failedRow).getByRole("button", { name: "Retry" }));

        const alert = await screen.findByTestId("privacy-retry-error");

        expect(alert.textContent).toContain("Request is not in a failed state");
        expect(retry).toHaveBeenCalledTimes(1);
    });
});
