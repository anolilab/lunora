import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { MutationCtx as MutationContext } from "../lunora/_generated/server.js";
import { fireDeployAlerts } from "../lunora/alerts";
import { renderDeployAlert } from "../src/telemetry/alerts";

/**
 * `deploy` alerts — the release path's notifications.
 *
 * Before these, a build that failed and a deployment that never reached `live`
 * were recorded in the dashboard and nowhere else: the alert rules only ever
 * evaluated telemetry the tenant's own app had to be instrumented to send, so
 * the one class of failure where the app never starts could not raise anything.
 */

const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    return { _id: "rule1", channel: "slack", destination: "https://hooks.slack.com/x", enabled: true, name: "Releases", target: "deploy", ...over };
};

/** The `ctx.db.insert` shape the helper calls, so the spy's recorded arguments stay typed. */
type InsertSpy = (table: string, document: Record<string, unknown>) => Promise<string>;

/** A structural stand-in for the mutation context — `fireDeployAlerts` reads only these three things. */
const fakeContext = (
    rules: Record<string, unknown>[],
    insert = vi.fn<InsertSpy>(() => Promise.resolve("alert1")),
): { context: MutationContext; insert: typeof insert } => {
    return {
        context: {
            db: { alertRules: { findMany: () => Promise.resolve({ page: rules }) }, insert },
            now: 1_700_000_000_000,
        } as unknown as MutationContext,
        insert,
    };
};

describe(fireDeployAlerts, () => {
    it("raises one firing alert per enabled rule, rendered and addressed", async () => {
        const { context, insert } = fakeContext([rule()]);

        const raised = await fireDeployAlerts(context, "org1" as never, "build:b1", {
            detail: "tsc exited 2",
            kind: "build",
            project: "Acme",
            reference: "main@abc1234",
        });

        expect(raised).toBe(1);
        expect(insert).toHaveBeenCalledWith(
            "alerts",
            expect.objectContaining({ channel: "slack", destination: "https://hooks.slack.com/x", hash: "build:b1", status: "firing", target: "deploy" }),
        );
    });

    it("skips a disabled rule", async () => {
        const { context, insert } = fakeContext([rule({ enabled: false })]);

        await expect(
            fireDeployAlerts(context, "org1" as never, "build:b1", { detail: "x", kind: "build", project: "Acme", reference: "main@abc" }),
        ).resolves.toBe(0);
        expect(insert).not.toHaveBeenCalled();
    });

    it("leaves the row undelivered — a mutation has no fetch, so the drain sweep sends it", async () => {
        const { context, insert } = fakeContext([rule()]);

        await fireDeployAlerts(context, "org1" as never, "build:b1", { detail: "x", kind: "build", project: "Acme", reference: "main@abc" });

        const document = insert.mock.calls[0]?.[1];

        expect(document?.status).toBe("firing");
        expect(document?.deliveredAt).toBeUndefined();
    });
});

describe(renderDeployAlert, () => {
    it("names the project and what happened in the subject, since that is all a phone shows", () => {
        const { body, subject } = renderDeployAlert(
            { name: "Releases" },
            { detail: "tsc exited 2", kind: "build", project: "Acme", reference: "main@abc1234" },
        );

        expect(subject).toBe("[Lunora] Releases: Acme — build failed");
        expect(body).toContain("main@abc1234");
        expect(body).toContain("tsc exited 2");
    });

    it("distinguishes the three release-path outcomes", () => {
        const source = { detail: "d", project: "Acme", reference: "r" };

        expect(renderDeployAlert({ name: "R" }, { ...source, kind: "deployment" }).subject).toContain("deployment failed");
        expect(renderDeployAlert({ name: "R" }, { ...source, kind: "rollout" }).subject).toContain("rollout aborted");
    });
});

/**
 * `updateStatus` is re-driven by the deploy orchestrator as it works through the
 * provisioner's events, and a retry can write `failed` over `failed`. Firing on
 * the state rather than the transition would page somebody once per attempt for
 * one broken release, which is how a notification feature gets turned off.
 *
 * Asserted over the source because the mutation needs a live control plane to
 * exercise, and the property is one line that is easy to lose in an edit.
 */
describe("updateStatus fires only on the transition into failed", () => {
    const source = readFileSync(fileURLToPath(new URL("../lunora/deployments.ts", import.meta.url)), "utf8");

    it("guards the fire on the previous status", () => {
        expect(source).toContain('if (status === "failed" && existing.status !== "failed")');
    });
});
