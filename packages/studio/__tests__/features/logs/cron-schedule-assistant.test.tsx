import type { CronJobInfo } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { CronTriggersPanel } from "../../../src/features/logs/cron-triggers-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const loadEmpty = async (): Promise<CronJobInfo[]> => [];

/** A deployment whose assistant can run, answering with `cron` (or degrading when it is undefined). */
const cronMock = (available: boolean, cron?: string): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available, level: available ? "schema" : "disabled" };
            }

            if (reference === ADMIN_FUNCTIONS.aiCronExpression) {
                return { result: cron === undefined ? { degraded: true, reason: "unsafe-response" } : { cron, degraded: false } };
            }

            return undefined;
        },
    });

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <CronTriggersPanel loadCronJobs={loadEmpty} />
    </LunoraProvider>
);

const describeSchedule = (text: string): void => {
    fireEvent.change(screen.getByTestId("cron-assistant-prompt"), { target: { value: text } });
    fireEvent.click(screen.getByTestId("cron-assistant-generate"));
};

describe("cronScheduleAssistant", () => {
    it("offers the expression to copy — the trigger list itself stays read-only", async () => {
        expect.assertions(2);

        render(renderPanel(cronMock(true, "0 3 * * 1-5")));

        describeSchedule("every weekday at 3am");

        const result = await screen.findByTestId("cron-assistant-result");

        expect(result.textContent).toBe("0 3 * * 1-5");
        expect(screen.getByTestId("cron-assistant-copy")).toBeDefined();
    });

    it("says so, and shows nothing to paste, when no deployable schedule came back", async () => {
        expect.assertions(2);

        render(renderPanel(cronMock(true)));

        describeSchedule("every 30 seconds");

        const reason = await screen.findByTestId("cron-assistant-reason");

        expect(reason.textContent).toContain("Cron Triggers accept");
        expect(screen.queryByTestId("cron-assistant-result")).toBeNull();
    });

    it("renders nothing at all when the assistant cannot run here", async () => {
        expect.assertions(1);

        render(renderPanel(cronMock(false)));

        // The panel itself still loads; only the affordance is withheld.
        await screen.findByTestId("cron-empty");

        expect(screen.queryByTestId("cron-assistant")).toBeNull();
    });
});
