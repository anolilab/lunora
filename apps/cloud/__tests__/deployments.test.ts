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
 * Fake mutation ctx over in-memory rows: `findMany` on deployments, members and
 * notification channels; `get` by id (rows first, then the project); recording
 * `patch` and `insert`. The caller is an owner of the `org` organization.
 */
const makeCtx = (
    rows: Row[],
    options: FakeOptions = {},
): { ctx: MutationCtx; inserted: { doc: Row; table: string }[]; patched: { id: string; patch: Row }[] } => {
    const { channels = [], project = { _id: "proj", name: "Acme" } } = options;
    const patched: { id: string; patch: Row }[] = [];
    const inserted: { doc: Row; table: string }[] = [];
    const members: Row[] = [{ organizationId: "org", role: "owner", userId: "user_1" }];
    const filtered = (source: Row[], args?: { where?: Row }): { page: Row[] } => {
        const where = args?.where ?? {};

        return { page: source.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)) };
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: "user_1" },
        // Handlers read the clock through `ctx.now` (deterministic under OCC retry),
        // so the double has to supply it — `Date.now()` is no longer reachable there.
        now: Date.now(),
        db: {
            deployments: {
                findMany: (args?: { where?: Row }) => Promise.resolve(filtered(rows, args)),
            },
            get: (id: string) => Promise.resolve(rows.find((row) => row["_id"] === id) ?? (id === project["_id"] ? project : null)),
            insert: (table: string, doc: Row) => {
                inserted.push({ doc, table });

                return Promise.resolve(`${table}_id`);
            },
            members: {
                findMany: (args?: { where?: Row }) => Promise.resolve(filtered(members, args)),
            },
            notificationChannels: {
                findMany: (args?: { where?: Row }) => Promise.resolve(filtered(channels, args)),
            },
            patch: (id: string, patch: Row) => {
                patched.push({ id, patch });

                return Promise.resolve();
            },
        },
        log: {},
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    // The mutations are rate-limited; the limiter's bucket store lives apart from the recorded writes.
    return { ctx: { ...ctx, db: withRateLimitStore(ctx.db) } as unknown as MutationCtx, inserted, patched };
};

const LIVE_CHANNEL = { _id: "chan", enabled: true, events: ["deployment.live", "deployment.failed"], kind: "slack", organizationId: "org" };

describe("deployments.cleanupExpiredPreviews", () => {
    it("destroys only expired, not-yet-destroyed previews", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([
            { _id: "live_expired", expiresAt: now - 1000, kind: "preview", status: "live" },
            { _id: "queued_expired", expiresAt: now - 1, kind: "preview", status: "queued" },
            { _id: "not_expired", expiresAt: now + 100_000, kind: "preview", status: "live" },
            { _id: "already_destroyed", expiresAt: now - 1000, kind: "preview", status: "destroyed" },
            { _id: "no_expiry", kind: "preview", status: "live" },
        ]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 2 });
        expect(patched.map((entry) => entry.id).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["live_expired", "queued_expired"]);
        expect(patched.every((entry) => entry.patch["status"] === "destroyed")).toBe(true);
    });

    it("queues one preview.expired notification per destroyed preview for each subscribed channel", async () => {
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

        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ table: "notificationDeliveries", doc: { channelId: "chan_on", event: "preview.expired", status: "pending" } });
    });

    it("is a no-op when nothing is expired", async () => {
        const now = Date.now();
        const { ctx, patched } = makeCtx([{ _id: "fresh", expiresAt: now + 100_000, kind: "preview", status: "live" }]);

        const result = await cleanupExpiredPreviews.handler(ctx, {});

        expect(result).toStrictEqual({ destroyed: 0 });
        expect(patched).toHaveLength(0);
    });
});

describe("deployments.activate", () => {
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

    it("announces deployment.live the first time the stable URL moves to the release", async () => {
        const { ctx, inserted, patched } = makeCtx([release], {
            channels: [LIVE_CHANNEL],
            project: { _id: "proj", activeDeploymentId: "dep_1", name: "Acme" },
        });

        await activate.handler(ctx, { id: "dep_2" as Id<"deployments"> });

        expect(patched.find((entry) => entry.id === "proj")?.patch).toMatchObject({ activeDeploymentId: "dep_2" });
        expect(inserted).toHaveLength(1);
        expect(inserted[0]?.doc).toMatchObject({
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

        expect(inserted).toHaveLength(0);
    });
});

describe("deployments.updateStatus", () => {
    const building = {
        _id: "dep_3" as Id<"deployments">,
        kind: "production",
        organizationId: "org",
        projectId: "proj",
        scriptName: "acme-v3",
        status: "building",
        version: 3,
    };

    it("announces a failure on the change into failed, without quoting an error", async () => {
        const { ctx, inserted } = makeCtx([building], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "failed" });

        expect(inserted).toHaveLength(1);
        expect(inserted[0]?.doc).toMatchObject({ event: "deployment.failed", status: "pending" });
        expect(inserted[0]?.doc["body"]).toBe('Deployment failed for "Acme" on Lunora Cloud.\nOpen the deployment in the dashboard for its log.');
    });

    it("does not announce live from the orchestrator report, since activation is what releases it", async () => {
        const { ctx, inserted } = makeCtx([{ ...building, status: "verifying" }], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "live", url: "https://acme-v3.example.app" });

        expect(inserted).toHaveLength(0);
    });

    it("does not re-announce a failure that is reported again", async () => {
        const { ctx, inserted } = makeCtx([{ ...building, status: "failed" }], { channels: [LIVE_CHANNEL] });

        await updateStatus.handler(ctx, { id: "dep_3" as Id<"deployments">, status: "failed" });

        expect(inserted).toHaveLength(0);
    });
});
