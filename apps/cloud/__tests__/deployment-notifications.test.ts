import { describe, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import type { MutationCtx } from "../lunora/_generated/server";
import { activate, cleanupExpiredPreviews, updateStatus } from "../lunora/deployments";
import withRateLimitStore from "./support/rate-limit-db";

type Row = Record<string, unknown>;

interface FakeOptions {
    channels?: Row[];
    project?: Row;
}

/**
 * Fake mutation ctx over in-memory rows. Records every insert with its table so
 * the notification outbox can be asserted apart from audit rows. The caller is an
 * owner of the `org` organization.
 */
const makeCtx = (rows: Row[], options: FakeOptions = {}): { ctx: MutationCtx; inserted: { doc: Row; table: string }[]; patched: { id: string; patch: Row }[] } => {
    const { channels = [], project = { _id: "proj", name: "Acme" } } = options;
    const patched: { id: string; patch: Row }[] = [];
    const inserted: { doc: Row; table: string }[] = [];
    const members: Row[] = [{ organizationId: "org", role: "owner", userId: "user_1" }];
    const filtered = (source: Row[], args?: { where?: Row }): { page: Row[] } => {
        const where = args?.where ?? {};

        return { page: source.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)) };
    };

    const database = {
        delete: () => Promise.resolve(),
        deployments: { findMany: (args?: { where?: Row }) => Promise.resolve(filtered(rows, args)) },
        get: (id: string) => Promise.resolve(rows.find((row) => row["_id"] === id) ?? (id === project["_id"] ? project : null)),
        insert: (table: string, doc: Row) => {
            inserted.push({ doc, table });

            return Promise.resolve(`${table}_id`);
        },
        alertRules: { findMany: () => Promise.resolve({ page: [] }) },
        members: { findMany: (args?: { where?: Row }) => Promise.resolve(filtered(members, args)) },
        notificationChannels: { findMany: (args?: { where?: Row }) => Promise.resolve(filtered(channels, args)) },
        patch: (id: string, patch: Row) => {
            patched.push({ id, patch });

            return Promise.resolve();
        },
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: "user_1" },
        // Handlers read the clock through `ctx.now`, so the double has to supply it.
        now: Date.now(),
        db: withRateLimitStore(database),
        log: {},
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, inserted, patched };
};

const notifications = (inserted: { doc: Row; table: string }[]): { doc: Row; table: string }[] =>
    inserted.filter((entry) => entry.table === "notificationDeliveries");

const LIVE_CHANNEL = { _id: "chan", enabled: true, events: ["deployment.live", "deployment.failed"], kind: "slack", organizationId: "org" };

describe("deployment notifications", () => {
    it("previews that expire queue one preview.expired delivery per subscribed channel", async () => {
        const now = Date.now();
        const { ctx, inserted } = makeCtx(
            [
                {
                    _id: "live_expired",
                    expiresAt: now - 1000,
                    kind: "preview",
                    organizationId: "org",
                    projectId: "proj",
                    scriptName: "acme-preview-1",
                    status: "live",
                },
                { _id: "not_expired", expiresAt: now + 100_000, kind: "preview", organizationId: "org", projectId: "proj", status: "live" },
            ],
            {
                channels: [
                    { _id: "chan_on", enabled: true, events: ["preview.expired"], kind: "slack", organizationId: "org" },
                    { _id: "chan_off", enabled: true, events: ["deployment.live"], kind: "slack", organizationId: "org" },
                ],
            },
        );

        await cleanupExpiredPreviews.handler(ctx, {});

        expect(notifications(inserted)).toHaveLength(1);
        expect(notifications(inserted)[0]).toMatchObject({ doc: { channelId: "chan_on", event: "preview.expired", status: "pending" } });
    });

    const release = {
        _id: "dep_2",
        kind: "production",
        organizationId: "org",
        projectId: "proj",
        scriptName: "acme-v2",
        status: "verifying",
        url: "https://acme-v2.example.app",
        version: 2,
    };

    it("announces deployment.live the first time a production activation moves the stable URL", async () => {
        const { ctx, inserted } = makeCtx([release], {
            channels: [LIVE_CHANNEL],
            project: { _id: "proj", activeDeploymentId: "dep_1", name: "Acme" },
        });

        await activate.handler(ctx, { id: "dep_2" as Id<"deployments"> });

        expect(notifications(inserted)).toHaveLength(1);
        expect(notifications(inserted)[0]?.doc).toMatchObject({
            body: expect.stringContaining("Version 2 is live at https://acme-v2.example.app.") as unknown,
            channelId: "chan",
            event: "deployment.live",
            status: "pending",
        });
    });

    it("stays quiet when the stable URL already points at the release, so a retried activation does not re-announce", async () => {
        const { ctx, inserted } = makeCtx([release], {
            channels: [LIVE_CHANNEL],
            project: { _id: "proj", activeDeploymentId: "dep_2", name: "Acme" },
        });

        await activate.handler(ctx, { id: "dep_2" as Id<"deployments"> });

        expect(notifications(inserted)).toHaveLength(0);
    });

    const building = { _id: "dep_3", kind: "production", organizationId: "org", projectId: "proj", scriptName: "acme-v3", status: "building", version: 3 };

    it("announces a failure on the change into failed, without quoting an error", async () => {
        const { ctx, inserted } = makeCtx([building], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "failed" });

        expect(notifications(inserted)).toHaveLength(1);
        expect(notifications(inserted)[0]?.doc).toMatchObject({ event: "deployment.failed", status: "pending" });
        expect(notifications(inserted)[0]?.doc["body"]).toBe('Deployment failed for "Acme" on Lunora Cloud.\nOpen the deployment in the dashboard for its log.');
    });

    it("does not announce live from the orchestrator report, since activation is what releases it", async () => {
        const { ctx, inserted } = makeCtx([{ ...building, status: "verifying" }], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "live", url: "https://acme-v3.example.app" });

        expect(notifications(inserted)).toHaveLength(0);
    });

    it("does not re-announce a failure that is reported again", async () => {
        const { ctx, inserted } = makeCtx([{ ...building, status: "failed" }], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "failed" });

        expect(notifications(inserted)).toHaveLength(0);
    });
});
