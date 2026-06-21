import type { CronJobInfo, ScheduleRecord } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { SchedulePanel } from "../../../src/features/logs/schedule-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const RECORDS: ScheduleRecord[] = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "b", scheduledFor: 2000 }];
const CRONS: CronJobInfo[] = [{ args: {}, cron: "0 9 * * *", functionPath: "report:daily", name: "daily digest" }];

const loadRecords = async (): Promise<ScheduleRecord[]> => RECORDS;
const loadCrons = async (): Promise<CronJobInfo[]> => CRONS;

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("schedulePanel", () => {
    it("defaults to the scheduled-jobs view", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <SchedulePanel scheduledLoad={loadRecords} />));

        await screen.findByTestId("sj-table");

        expect(screen.queryByTestId("lunora-cron-triggers")).toBeNull();
    });

    it("switches to the cron-triggers view on toggle", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <SchedulePanel loadCronJobs={loadCrons} scheduledLoad={loadRecords} />));

        await screen.findByTestId("sj-table");

        fireEvent.click(screen.getByTestId("schedule-view-cron"));

        const table = await screen.findByTestId("cron-table");

        expect(table).toBeDefined();
    });
});
