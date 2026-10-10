/**
 * The notification outbox sweep. Runs from the control plane's every-minute
 * `scheduled()` tick. It delivers due `pending` rows, oldest first; a retryable
 * failure is rescheduled with exponential backoff until the attempt budget is
 * spent, and a permanent one is stamped `failed` at once. It also prunes finished
 * rows past their retention window. Expressed over the structural
 * {@link ControlPlaneDb} like the other sweeps, so it is testable with a fake
 * store and a fake `fetch`.
 */
import { decryptSecret } from "../secrets/crypto";
import type { ControlPlaneDatabase } from "../store";
import { type ChannelTarget, deliverNotification, NotificationDeliveryError, notificationRequestFor } from "./deliver";
import type { NotificationKind, NotificationMessage } from "./events";

/**
 * Pending rows considered per tick. Kept small so the whole batch finishes inside
 * one minute even when every endpoint hangs to its request timeout.
 */
export const BATCH_SIZE = 20;

/** Send attempts before a retryable failure is given up as `failed`. */
export const MAX_ATTEMPTS = 5;

/** First retry waits this long; each later one doubles, up to {@link BACKOFF_CAP_MS}. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/** Finished rows older than this are deleted. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Finished rows deleted per tick, per status, so a backlog drains over several runs. */
const PRUNE_LIMIT = 200;

/** Delay before attempt `attempts + 1`, after `attempts` failed sends. */
export const retryDelayMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);

interface ChannelRow {
    _id: string;
    destination: string;
    enabled: boolean;
    kind: NotificationKind;
    secretCiphertext?: string;
    secretIv?: string;
}

interface PendingRow extends NotificationMessage {
    _id: string;
    attempts: number;
    channelId: string;
    kind: NotificationKind;
    nextAttemptAt: number;
    organizationId: string;
}

export interface NotificationSweepOptions {
    fetch: typeof globalThis.fetch;
    now: number;
    /** `SECRET_ENCRYPTION_KEY`, to decrypt channel secrets. Without it, secret-bearing channels fail permanently. */
    secretKey?: string;
}

export interface NotificationSweepResult {
    delivered: number;
    failed: number;
    pruned: number;
    retrying: number;
}

/** Why a row was not sent, and whether another attempt could succeed. `null` means it was sent. */
type Outcome = { error: string; retryable: boolean } | null;

/** The channel's plaintext secret, or `undefined` when it has none. Throws when it cannot be read. */
const resolveSecret = async (channel: ChannelRow, secretKey: string | undefined): Promise<string | undefined> => {
    if (channel.secretCiphertext === undefined || channel.secretIv === undefined) {
        return undefined;
    }

    if (!secretKey) {
        throw new Error("channel secret cannot be read: encryption key is not configured");
    }

    return decryptSecret(secretKey, { ciphertext: channel.secretCiphertext, iv: channel.secretIv });
};

/** Send the row over its channel. A missing, disabled or unreadable channel is refused without a request. */
const send = async (row: PendingRow, channel: ChannelRow | undefined, options: NotificationSweepOptions): Promise<Outcome> => {
    if (!channel) {
        return { error: "channel was removed", retryable: false };
    }

    if (!channel.enabled) {
        return { error: "channel was disabled before delivery", retryable: false };
    }

    let secret: string | undefined;

    try {
        secret = await resolveSecret(channel, options.secretKey);
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : "channel secret unreadable", retryable: false };
    }

    const target: ChannelTarget = { destination: channel.destination, kind: channel.kind, secret };

    try {
        await deliverNotification(options.fetch, await notificationRequestFor(target, row, options.now));

        return null;
    } catch (error: unknown) {
        // The message names only the status or the refusal reason, never the URL.
        if (error instanceof NotificationDeliveryError) {
            return { error: error.message, retryable: error.retryable };
        }

        return { error: "delivery failed", retryable: true };
    }
};

/** Deliver one due row and stamp its outcome: delivered, rescheduled, or failed. */
const deliverOne = async (
    database: ControlPlaneDatabase,
    row: PendingRow,
    channel: ChannelRow | undefined,
    options: NotificationSweepOptions,
): Promise<keyof Omit<NotificationSweepResult, "pruned">> => {
    const outcome = await send(row, channel, options);

    if (outcome === null) {
        await database.patch(row._id, { attempts: row.attempts + 1, deliveredAt: options.now, status: "delivered", updatedAt: options.now }, "notificationDeliveries");

        return "delivered";
    }

    const attempts = row.attempts + 1;

    if (outcome.retryable && attempts < MAX_ATTEMPTS) {
        await database.patch(
            row._id,
            { attempts, error: outcome.error, nextAttemptAt: options.now + retryDelayMs(attempts), status: "pending", updatedAt: options.now },
            "notificationDeliveries",
        );

        return "retrying";
    }

    await database.patch(row._id, { attempts, error: outcome.error, status: "failed", updatedAt: options.now }, "notificationDeliveries");

    return "failed";
};

/** Delete finished rows older than the retention window, a bounded page per status. */
const pruneFinished = async (database: ControlPlaneDatabase, now: number): Promise<number> => {
    let pruned = 0;

    for (const status of ["delivered", "failed"]) {
        // eslint-disable-next-line no-await-in-loop -- two statuses, one bounded read each
        const { page } = await database.findMany("notificationDeliveries", { limit: PRUNE_LIMIT, orderBy: [{ updatedAt: "asc" }], where: { status } });

        for (const row of page as { _id: string; updatedAt: number }[]) {
            if (row.updatedAt < now - RETENTION_MS) {
                // eslint-disable-next-line no-await-in-loop -- bounded page; sequential deletes keep the writer simple
                await database.delete(row._id, "notificationDeliveries");
                pruned += 1;
            }
        }
    }

    return pruned;
};

/**
 * Run one sweep: deliver the due outbox, then prune. Rows are read oldest-due
 * first, so a backlog can't starve behind rows scheduled for later. Channels are
 * read per organization in the batch, so a page limit on the channel table can't
 * make a live channel look removed.
 */
export const runNotificationSweep = async (database: ControlPlaneDatabase, options: NotificationSweepOptions): Promise<NotificationSweepResult> => {
    const { page: pendingPage } = await database.findMany("notificationDeliveries", {
        limit: BATCH_SIZE,
        orderBy: [{ nextAttemptAt: "asc" }],
        where: { status: "pending" },
    });

    const due = (pendingPage as unknown as PendingRow[]).filter((row) => row.nextAttemptAt <= options.now);
    const channels = new Map<string, ChannelRow>();

    for (const organizationId of new Set(due.map((row) => row.organizationId))) {
        // eslint-disable-next-line no-await-in-loop -- one read per org in this batch; the batch is small
        const { page } = await database.findMany("notificationChannels", { where: { organizationId } });

        for (const channel of page as unknown as ChannelRow[]) {
            channels.set(channel._id, channel);
        }
    }

    const outcomes = await Promise.all(due.map((row) => deliverOne(database, row, channels.get(row.channelId), options)));
    const pruned = await pruneFinished(database, options.now);

    return {
        delivered: outcomes.filter((outcome) => outcome === "delivered").length,
        failed: outcomes.filter((outcome) => outcome === "failed").length,
        pruned,
        retrying: outcomes.filter((outcome) => outcome === "retrying").length,
    };
};
