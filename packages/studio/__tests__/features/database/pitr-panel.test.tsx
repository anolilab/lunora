import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { PitrPanel } from "../../../src/features/database/pitr-panel";
import type { PitrBookmarkResult, PitrRestoreResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderPanel = (mock: MockClientHooks, initialShardKey?: string): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <PitrPanel initialShardKey={initialShardKey} />
    </LunoraProvider>
);

describe("pitrPanel", () => {
    it("loads and shows the current bookmark", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getPitrBookmark) {
                    return { current: "bm-current" } satisfies PitrBookmarkResult;
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        await waitFor(() => {
            if (screen.getByTestId("pitr-current").textContent !== "bm-current") {
                throw new Error("not loaded");
            }
        });

        expect(screen.getByTestId("pitr-current").textContent).toBe("bm-current");
    });

    it("previews the bookmark for a typed time", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference !== ADMIN_FUNCTIONS.getPitrBookmark) {
                    throw new Error(`unexpected ${reference}`);
                }

                const { time } = args as { time?: string };

                return { current: "bm-current", ...(time === undefined ? {} : { forTime: "bm-for-time" }) } satisfies PitrBookmarkResult;
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("pitr-current");

        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "2026-06-01T00:00:00.000Z" } });
        fireEvent.click(screen.getByTestId("pitr-preview"));

        await screen.findByTestId("pitr-preview-bookmark");

        expect(screen.getByTestId("pitr-preview-bookmark").textContent).toContain("bm-for-time");
    });

    it("restores to an explicit bookmark after confirm and shows the undo bookmark", async () => {
        expect.assertions(3);

        let restoreArgs: Record<string, unknown> | undefined;
        const mock = createMockClient({
            mutation: (reference, args): unknown => {
                if (reference !== ADMIN_FUNCTIONS.pitrRestore) {
                    throw new Error(`unexpected ${reference}`);
                }

                restoreArgs = args as Record<string, unknown>;

                return { restarted: false, restoredTo: "bm-target", undoBookmark: "bm-undo" } satisfies PitrRestoreResult;
            },
            query: (): unknown => ({ current: "bm-current" }) satisfies PitrBookmarkResult,
        });

        render(renderPanel(mock));

        await screen.findByTestId("pitr-current");

        fireEvent.change(screen.getByTestId("pitr-bookmark"), { target: { value: "bm-target" } });
        fireEvent.click(screen.getByTestId("pitr-restore"));
        fireEvent.click(screen.getByTestId("pitr-restore-confirm"));

        await screen.findByTestId("pitr-result");

        expect(restoreArgs).toStrictEqual({ bookmark: "bm-target" });
        expect(screen.getByTestId("pitr-undo-bookmark").textContent).toContain("bm-undo");
        expect(mock.mutation).toHaveBeenCalledTimes(1);
    });

    it("sends typed epoch-ms and ISO times as epoch-ms numbers", async () => {
        expect.hasAssertions();

        const times: unknown[] = [];
        const mock = createMockClient({
            query: (_reference, args): unknown => {
                const { time } = args as { time?: unknown };

                if (time !== undefined) {
                    times.push(time);
                }

                return { current: "bm-current", forTime: "bm-for-time" } satisfies PitrBookmarkResult;
            },
        });

        render(renderPanel(mock));
        await screen.findByTestId("pitr-current");

        // The worker `Date.parse`s a string, which is NaN for a run of digits.
        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "1717200000000" } });

        expect(screen.getByTestId("pitr-time-resolved").textContent).toContain("2024-06-01T00:00:00.000Z");

        fireEvent.click(screen.getByTestId("pitr-preview"));
        await waitFor(() => {
            expect(times).toStrictEqual([1_717_200_000_000]);
        });

        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "2026-06-01T00:00:00.000Z" } });
        fireEvent.click(screen.getByTestId("pitr-preview"));
        await waitFor(() => {
            expect(times).toStrictEqual([1_717_200_000_000, Date.UTC(2026, 5, 1)]);
        });
    });

    it("refuses text that is not a time before sending anything", async () => {
        expect.assertions(2);

        const mock = createMockClient({ query: (): unknown => ({ current: "bm-current" }) satisfies PitrBookmarkResult });

        render(renderPanel(mock));
        await screen.findByTestId("pitr-current");
        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "yesterday-ish" } });

        expect(screen.getByTestId<HTMLButtonElement>("pitr-preview").disabled).toBe(true);
        expect(screen.getByTestId("pitr-time-resolved").textContent).toContain("Not a time");
    });

    it("treats epoch-ms past the Date range as not a time instead of crashing", async () => {
        expect.assertions(1);

        const mock = createMockClient({ query: (): unknown => ({ current: "bm-current" }) satisfies PitrBookmarkResult });

        render(renderPanel(mock));
        await screen.findByTestId("pitr-current");
        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "8640000000000001" } });

        expect(screen.getByTestId("pitr-time-resolved").textContent).toContain("Not a time");
    });

    it("names the shard and the target in the restore confirmation", async () => {
        expect.assertions(3);

        // The most destructive action in the studio confirmed with a bare
        // "Confirm restore" — naming neither which shard it would rewind nor to
        // when. The Time Travel view is shard-scoped and the operator may have
        // several open.
        const mock = createMockClient({
            query: (): unknown => ({ current: "bm-current" }) satisfies PitrBookmarkResult,
        });

        render(renderPanel(mock, "tenant-42"));

        await screen.findByTestId("pitr-current");

        fireEvent.change(screen.getByTestId("pitr-time"), { target: { value: "2026-06-01T00:00:00.000Z" } });
        fireEvent.click(screen.getByTestId("pitr-restore"));

        const confirm = screen.getByTestId("pitr-restore-confirm");

        expect(confirm.textContent).toContain("tenant-42");
        expect(confirm.textContent).toContain("2026-06-01T00:00:00.000Z");
        expect(confirm.textContent).not.toBe("Confirm restore");
    });

    it("surfaces a read failure as an error", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (): unknown => {
                throw new Error("PITR_UNAVAILABLE");
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("pitr-error");

        expect(screen.getByTestId("pitr-error").textContent).toContain("PITR_UNAVAILABLE");
    });
});
