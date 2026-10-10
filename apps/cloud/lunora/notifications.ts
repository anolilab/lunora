import { LunoraError } from "@lunora/server";

import { invalidDestinationReason, maskDestination } from "../src/notifications/deliver";
import type { NotificationEvent, NotificationKind } from "../src/notifications/events";
import { NOTIFICATION_EVENTS, renderNotification } from "../src/notifications/events";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { rateLimit } from "./guards";
import { queueDelivery } from "./notification-outbox";
import { boundedString, LIMITS } from "./validators";

/**
 * Lifecycle notification channels (deploy, domain and preview events). Owners and
 * admins read and manage channels; other members learn only that the section is
 * theirs to see. A channel's secret (a Telegram bot token or a webhook signing key)
 * is sealed at the edge before it reaches this module, so only ciphertext is ever
 * stored, and reads return it as a boolean. Destinations are masked. Events are
 * queued by the lifecycle mutations and delivered by the edge sweep.
 */

/** Deliveries the list shows, newest first. */
const DELIVERY_LIMIT = 50;

/** Roles that may read and manage notification channels. */
const MANAGER_ROLES = ["owner", "admin"] as const;

const kindValidator = v.union(v.literal("discord"), v.literal("slack"), v.literal("telegram"), v.literal("webhook"));

const eventValidator = v.union(
    v.literal("deployment.live"),
    v.literal("deployment.failed"),
    v.literal("deployment.rolled_back"),
    v.literal("domain.verified"),
    v.literal("domain.failed"),
    v.literal("preview.expired"),
);

interface ChannelRow {
    _id: Id<"notificationChannels">;
    createdAt: number;
    destination: string;
    enabled: boolean;
    events: NotificationEvent[];
    kind: NotificationKind;
    name: string;
    organizationId: Id<"organizations">;
    secretCiphertext?: string;
    secretIv?: string;
    updatedAt: number;
}

interface DeliveryRow {
    _id: Id<"notificationDeliveries">;
    channelId: Id<"notificationChannels">;
    createdAt: number;
    deliveredAt?: number;
    error?: string;
    event: NotificationEvent | "test";
    kind: NotificationKind;
    status: "delivered" | "failed" | "pending";
    subject: string;
}

/** A channel as an owner or admin sees it: no secret, destination masked. */
interface ChannelView {
    _id: Id<"notificationChannels">;
    createdAt: number;
    destination: string;
    enabled: boolean;
    events: NotificationEvent[];
    hasSecret: boolean;
    kind: NotificationKind;
    name: string;
}

/** A delivery as the deliveries list shows it: the outbox row plus its channel's name. */
interface DeliveryView {
    _id: Id<"notificationDeliveries">;
    channelId: Id<"notificationChannels">;
    channelName: string;
    createdAt: number;
    deliveredAt?: number;
    error?: string;
    event: NotificationEvent | "test";
    kind: NotificationKind;
    status: "delivered" | "failed" | "pending";
    subject: string;
}

/**
 * Channels for an org, masked, newest first. `canManage` is false for a plain
 * member, who gets an empty list rather than a permission error, so the section
 * can explain itself instead of waiting forever on a query that never resolves.
 */
export const channels = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<{ canManage: boolean; channels: ChannelView[] }> => {
        const member = await assertMember(context, organizationId);

        if (!(MANAGER_ROLES as readonly string[]).includes(member.role)) {
            return { canManage: false, channels: [] };
        }

        const { page } = await context.db.notificationChannels.findMany({ where: { organizationId } });

        return {
            canManage: true,
            channels: (page as unknown as ChannelRow[])
                .toSorted((a, b) => b.createdAt - a.createdAt)
                .map((channel) => {
                    return {
                        _id: channel._id,
                        createdAt: channel.createdAt,
                        destination: maskDestination(channel.kind, channel.destination),
                        enabled: channel.enabled,
                        events: channel.events,
                        hasSecret: channel.secretCiphertext !== undefined,
                        kind: channel.kind,
                        name: channel.name,
                    };
                }),
        };
    });

/** Recent deliveries for an org, newest first, with the channel name resolved. Empty for a plain member. */
export const deliveries = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<DeliveryView[]> => {
        const member = await assertMember(context, organizationId);

        if (!(MANAGER_ROLES as readonly string[]).includes(member.role)) {
            return [];
        }

        const { page: channelPage } = await context.db.notificationChannels.findMany({ where: { organizationId } });
        const names = new Map((channelPage as unknown as ChannelRow[]).map((channel) => [channel._id, channel.name]));
        // Sorted and capped in the store, so the newest rows are the ones returned.
        const { page } = await context.db.notificationDeliveries.findMany({
            limit: DELIVERY_LIMIT,
            orderBy: [{ createdAt: "desc" }],
            where: { organizationId },
        });

        return (page as unknown as DeliveryRow[]).map((row) => {
            return { ...row, channelName: names.get(row.channelId) ?? "removed channel" };
        });
    });

/**
 * Create a channel (owners/admins). The edge route `POST /v1/notification-channels`
 * generates or takes the secret, seals it with the master key, and calls this with
 * the ciphertext, so no plaintext secret reaches the database. New channels
 * subscribe to every event unless told otherwise.
 */
export const createChannel = mutation
    .use(rateLimit("api"))
    .input({
        destination: boundedString(LIMITS.url),
        events: v.optional(v.array(eventValidator)),
        kind: kindValidator,
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        secretCiphertext: v.optional(boundedString(LIMITS.secret)),
        secretIv: v.optional(boundedString(LIMITS.id)),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"notificationChannels">> => {
        const { organizationId } = await assertMember(context, args.organizationId, MANAGER_ROLES);

        const hasSecret = args.secretCiphertext !== undefined && args.secretIv !== undefined;
        const reason = invalidDestinationReason(args.kind, args.destination.trim(), hasSecret);

        if (reason) {
            throw new LunoraError("BAD_REQUEST", reason);
        }

        if (args.kind === "webhook" && !hasSecret) {
            throw new LunoraError("BAD_REQUEST", "webhook channels need a signing key");
        }

        const { now } = context;

        return context.db.insert("notificationChannels", {
            createdAt: now,
            destination: args.destination.trim(),
            enabled: true,
            events: args.events ?? [...NOTIFICATION_EVENTS],
            kind: args.kind,
            name: args.name,
            organizationId,
            ...(hasSecret ? { secretCiphertext: args.secretCiphertext, secretIv: args.secretIv } : {}),
            updatedAt: now,
        });
    });

/** Rename a channel, switch it on or off, or change the events it subscribes to (owners/admins). */
export const updateChannel = mutation
    .use(rateLimit("api"))
    .input({
        enabled: v.optional(v.boolean()),
        events: v.optional(v.array(eventValidator)),
        id: v.id("notificationChannels"),
        name: v.optional(boundedString(LIMITS.name)),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"notificationChannels">> => {
        await assertMember(context, args.organizationId, MANAGER_ROLES);
        await assertRowInOrg(context, args.id, args.organizationId, "notification channel");

        await context.db.patch(args.id, {
            ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
            ...(args.events === undefined ? {} : { events: args.events }),
            ...(args.name === undefined ? {} : { name: args.name }),
            updatedAt: context.now,
        });

        return args.id;
    });

/** Delete a channel (owners/admins). Its undelivered rows fail on the next sweep, and its history stays until pruned. */
export const deleteChannel = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("notificationChannels"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<Id<"notificationChannels">> => {
        await assertMember(context, organizationId, MANAGER_ROLES);
        await assertRowInOrg(context, id, organizationId, "notification channel");
        await context.db.delete(id);

        return id;
    });

/**
 * Queue a test message to one channel (owners/admins). It is delivered by the next
 * sweep, about a minute later, and the outcome appears in the deliveries list. A
 * disabled channel is refused, so the test reflects what a live event would do.
 */
export const sendTest = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("notificationChannels"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<Id<"notificationDeliveries">> => {
        await assertMember(context, organizationId, MANAGER_ROLES);
        await assertRowInOrg(context, id, organizationId, "notification channel");

        const channel = (await context.db.get(id)) as ChannelRow | null;

        if (!channel) {
            throw new LunoraError("NOT_FOUND", "notification channel not found");
        }

        if (!channel.enabled) {
            throw new LunoraError("BAD_REQUEST", "enable the channel before sending a test");
        }

        const message = renderNotification("test", { detail: `Sent to the "${channel.name}" channel.`, project: "Lunora Cloud" });

        return queueDelivery(context, channel, message, organizationId);
    });
