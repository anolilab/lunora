import { describe, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../lunora/_generated/server";
import { createChannel, channels } from "../lunora/notifications";
import { markVerified } from "../lunora/domains";
import withRateLimitStore from "./support/rate-limit-db";

type Row = Record<string, unknown> & { _id: string };

interface FakeOptions {
    channels?: Row[];
    domains?: Row[];
    role?: string;
}

/**
 * Fake ctx over in-memory rows. The caller is `user_1` with the given role in the
 * `org` organization. `get` resolves by id across domains, channels and projects.
 */
const makeCtx = (options: FakeOptions = {}) => {
    const { channels: channelRows = [], domains = [], role = "owner" } = options;
    const inserted: { doc: Row; table: string }[] = [];
    const patched: { id: string; patch: Row }[] = [];
    const projects: Row[] = [{ _id: "proj", name: "Acme" }];
    const tables: Record<string, Row[]> = {
        domains,
        members: [{ _id: "m1", organizationId: "org", role, userId: "user_1" }],
        notificationChannels: channelRows,
        projects,
    };
    const filtered = (source: Row[], args?: { where?: Record<string, unknown> }): { page: Row[] } => ({
        page: source.filter((row) => Object.entries(args?.where ?? {}).every(([key, value]) => row[key] === value)),
    });

    const database = {
        delete: () => Promise.resolve(),
        get: (id: string) =>
            Promise.resolve(
                Object.values(tables)
                    .flat()
                    .find((row) => row._id === id) ?? null,
            ),
        insert: (table: string, doc: Row) => {
            inserted.push({ doc, table });

            return Promise.resolve(`${table}_id`);
        },
        members: { findMany: (args?: { where?: Record<string, unknown> }) => Promise.resolve(filtered(tables["members"] ?? [], args)) },
        notificationChannels: { findMany: (args?: { where?: Record<string, unknown> }) => Promise.resolve(filtered(channelRows, args)) },
        notificationDeliveries: { findMany: () => Promise.resolve({ page: [] }) },
        patch: (id: string, patch: Row) => {
            patched.push({ id, patch });

            return Promise.resolve();
        },
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: "user_1" },
        now: 1_700_000_000_000,
        db: withRateLimitStore(database),
    };

    return { ctx: ctx as unknown as MutationCtx, inserted, patched, queryCtx: ctx as unknown as QueryCtx };
};

const ORG = "org" as Id<"organizations">;

describe("domain notifications", () => {
    it("announces a domain's first verification and stamps when it was checked", async () => {
        const { ctx, inserted, patched } = makeCtx({
            channels: [{ _id: "chan", enabled: true, events: ["domain.verified"], kind: "slack", organizationId: "org" }],
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org", projectId: "proj" }],
        });

        await markVerified.handler(ctx, { id: "dom_1" as Id<"domains">, organizationId: ORG, verified: true });

        expect(inserted).toHaveLength(1);
        expect(inserted[0]?.doc).toMatchObject({ event: "domain.verified", status: "pending" });
        expect(patched.find((entry) => entry.id === "dom_1")?.patch).toMatchObject({ lastCheckedAt: ctx.now });
    });

    it("announces domain.failed once when a verified domain stops validating", async () => {
        const { ctx, inserted } = makeCtx({
            channels: [{ _id: "chan", enabled: true, events: ["domain.failed"], kind: "slack", organizationId: "org" }],
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org", projectId: "proj", verifiedAt: 1 }],
        });

        await markVerified.handler(ctx, { id: "dom_1" as Id<"domains">, organizationId: ORG, verified: false });

        expect(inserted).toHaveLength(1);
        expect(inserted[0]?.doc).toMatchObject({ channelId: "chan", event: "domain.failed", status: "pending" });
        expect(inserted[0]?.doc["body"]).toBe(
            'Domain failed for "Acme" on Lunora Cloud.\napp.example.com no longer validates. Check its DNS records in the domain settings.',
        );
    });

    it("stays quiet when a domain that was never verified fails a check", async () => {
        const { ctx, inserted } = makeCtx({
            channels: [{ _id: "chan", enabled: true, events: ["domain.failed"], kind: "slack", organizationId: "org" }],
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org", projectId: "proj" }],
        });

        await markVerified.handler(ctx, { id: "dom_1" as Id<"domains">, organizationId: ORG, verified: false });

        expect(inserted).toHaveLength(0);
    });
});

describe("notification channel access", () => {
    const channelRow = {
        _id: "chan",
        createdAt: 1,
        destination: "https://hooks.example.com/services/T000/B000/topsecret",
        enabled: true,
        events: ["deployment.live"],
        kind: "slack",
        name: "Team",
        organizationId: "org",
        secretCiphertext: "sealed",
        secretIv: "iv",
        updatedAt: 1,
    };

    it("gives a plain member no channels and says so, rather than leaking them", async () => {
        const { queryCtx } = makeCtx({ channels: [channelRow], role: "member" });

        const result = await channels.handler(queryCtx, { organizationId: ORG });

        expect(result).toStrictEqual({ canManage: false, channels: [] });
    });

    it("returns masked channels to an admin, with the secret reduced to a flag", async () => {
        const { queryCtx } = makeCtx({ channels: [channelRow], role: "admin" });

        const result = await channels.handler(queryCtx, { organizationId: ORG });

        expect(result.canManage).toBe(true);
        expect(result.channels).toStrictEqual([
            {
                _id: "chan",
                createdAt: 1,
                destination: "https://hooks.example.com/…cret",
                enabled: true,
                events: ["deployment.live"],
                hasSecret: true,
                kind: "slack",
                name: "Team",
            },
        ]);
        expect(JSON.stringify(result)).not.toContain("secretCiphertext");
    });
});

describe("createChannel", () => {
    it("refuses a webhook channel that arrives without a signing key", async () => {
        const { ctx, inserted } = makeCtx();

        await expect(
            createChannel.handler(ctx, {
                destination: "https://hooks.example.com/x",
                kind: "webhook",
                name: "Hook",
                organizationId: ORG,
            }),
        ).rejects.toThrow("webhook channels need a signing key");
        expect(inserted).toHaveLength(0);
    });

    it("stores only the sealed secret, and defaults the channel to every event", async () => {
        const { ctx, inserted } = makeCtx();

        await createChannel.handler(ctx, {
            destination: "https://hooks.example.com/x",
            kind: "webhook",
            name: "Hook",
            organizationId: ORG,
            secretCiphertext: "sealed-bytes",
            secretIv: "iv-bytes",
        });

        expect(inserted).toHaveLength(1);
        const doc = inserted[0]?.doc ?? {};

        expect(doc).toMatchObject({ secretCiphertext: "sealed-bytes", secretIv: "iv-bytes" });
        expect(doc).not.toHaveProperty("secret");
        expect(doc["events"]).toContain("domain.failed");
    });
});
