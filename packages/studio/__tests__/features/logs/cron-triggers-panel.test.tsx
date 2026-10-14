import type { CronJobInfo } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CronTriggersPanel } from "../../../src/features/logs/cron-triggers-panel";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const CRON_ROW = /^cron-row-/;

const JOBS: CronJobInfo[] = [
    { args: {}, cron: "0 9 * * *", functionPath: "report:daily", name: "daily digest" },
    { args: { tenant: "acme" }, cron: "*/5 * * * *", functionPath: "presence:clear", name: "clear presence", shardKey: "acme" },
];

const WORKFLOW_JOBS: CronJobInfo[] = [{ args: { region: "eu" }, cron: "0 9 * * *", name: "nightly digest", workflow: "WORKFLOW_DIGEST" }];

const loadEmpty = async (): Promise<CronJobInfo[]> => [];

const withProvider = (mock: MockClientHooks, children: ReactNode): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;

describe("cronTriggersPanel", () => {
    it("renders triggers sorted by name with cron + function + shard", async () => {
        expect.assertions(4);

        const loadCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => JOBS);

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadCronJobs} />));

        await screen.findByTestId("cron-table");

        const rows = screen.getAllByTestId(CRON_ROW);

        expect(rows).toHaveLength(2);
        expect(screen.getByText("*/5 * * * *")).toBeDefined();
        expect(screen.getByText("presence:clear")).toBeDefined();
        expect(screen.getByText("acme")).toBeDefined();
    });

    it("falls back to the client when no loader is supplied", async () => {
        expect.assertions(1);

        const mock = createMockClient({ getCronJobs: () => JOBS });

        render(withProvider(mock, <CronTriggersPanel />));

        await screen.findByTestId("cron-table");

        expect(mock.getCronJobs).toHaveBeenCalledTimes(1);
    });

    it("shows the empty state when there are no triggers", async () => {
        expect.assertions(1);

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadEmpty} />));

        const empty = await screen.findByTestId("cron-empty");

        expect(empty).toBeDefined();
    });

    it("surfaces a load error", async () => {
        expect.assertions(1);

        const loadCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => {
            throw new Error("boom");
        });

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadCronJobs} />));

        const error = await screen.findByTestId("cron-error");

        expect(error.textContent).toContain("boom");
    });

    it("labels a workflow target with a workflow badge and its binding", async () => {
        expect.assertions(2);

        const loadCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => WORKFLOW_JOBS);

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadCronJobs} />));

        await screen.findByTestId("cron-table");

        expect(screen.getByText("workflow")).toBeDefined();
        expect(screen.getByText("WORKFLOW_DIGEST")).toBeDefined();
    });

    it("runs a cron job on demand and shows it ran", async () => {
        expect.assertions(2);

        const loadCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => JOBS);
        const runCronJob = vi.fn<(name: string) => Promise<{ name: string; ran: boolean }>>(async (name: string) => {
            return { name, ran: true };
        });

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadCronJobs} runCronJob={runCronJob} />));

        await screen.findByTestId("cron-table");

        // ConfirmButton: first click reveals confirm, second fires.
        fireEvent.click(screen.getByTestId("cron-run-daily digest"));
        fireEvent.click(screen.getByTestId("cron-run-daily digest-confirm"));

        await screen.findByTestId("cron-ran-daily digest");

        expect(runCronJob).toHaveBeenCalledWith("daily digest");
        expect(runCronJob).toHaveBeenCalledTimes(1);
    });

    it("surfaces a run error inline without affecting other rows", async () => {
        expect.hasAssertions();

        const loadCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => JOBS);
        const runCronJob = vi.fn<(name: string) => Promise<{ name: string; ran: boolean }>>(async () => {
            throw new Error("dispatch failed");
        });

        render(withProvider(createMockClient(), <CronTriggersPanel loadCronJobs={loadCronJobs} runCronJob={runCronJob} />));

        await screen.findByTestId("cron-table");

        fireEvent.click(screen.getByTestId("cron-run-clear presence"));
        fireEvent.click(screen.getByTestId("cron-run-clear presence-confirm"));

        await waitFor(() => {
            expect(screen.getByTestId("cron-run-error-clear presence").textContent).toContain("dispatch failed");
        });
    });
});
