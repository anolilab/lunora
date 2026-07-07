import { LunoraError } from "@lunora/errors";

/**
 * Native Durable-Object point-in-time recovery (the "in-place ≤30-day" tier).
 *
 * SQLite-backed DOs expose a built-in PITR API on `ctx.storage`: a *bookmark*
 * is an opaque, lexically-comparable string naming a moment in the object's
 * change log, and the runtime can restore the whole SQLite database (SQL + KV)
 * to any bookmark within the last 30 days. This module is the thin, testable
 * wrapper Lunora's admin layer drives; the heavier snapshot-to-R2 + CDC-replay
 * path (`registry/backup` + `lunora backup restore`) is the complementary tier
 * for >30-day / off-platform / portable recovery.
 *
 * See https://developers.cloudflare.com/durable-objects/api/storage-api/ — the
 * `getCurrentBookmark` / `getBookmarkForTime` / `onNextSessionRestoreBookmark`
 * methods. The methods are absent in local dev (no durable change log), so every
 * entry point degrades to a typed `PITR_UNAVAILABLE` error rather than throwing
 * an opaque `undefined is not a function`.
 */

/**
 * The subset of the DO storage surface this module needs. All three methods are
 * optional so the type also models local dev / the unit-test harness, where the
 * runtime doesn't provide them.
 */
interface PitrStorage {
    /** Bookmark for an approximate past `time` (≤30 days). Numbers are epoch-ms. */
    getBookmarkForTime?: (time: Date | number) => Promise<string>;
    /** Bookmark naming the object's current point in history. */
    getCurrentBookmark?: () => Promise<string>;

    /**
     * Arm the object to restore to `bookmark` on its next restart. Returns a
     * bookmark for the instant *before* recovery — keep it to undo the restore.
     */
    onNextSessionRestoreBookmark?: (bookmark: string) => Promise<string>;
}

/** Result of `getPitrBookmark`: the current bookmark, plus the one for a queried time. */
interface PitrBookmarkResult {
    /** Bookmark for the object's current state. */
    current: string;
    /** Bookmark for the requested `time`, when one was asked for. */
    forTime?: string;
}

/** Result of arming a `pitrRestore`. */
interface PitrRestoreResult {
    /** Whether the caller asked the shard to restart immediately (`ctx.abort`). */
    restarted: boolean;
    /** The bookmark the shard will restore to on next restart. */
    restoredTo: string;
    /** Bookmark for the instant before recovery — pass it back to `pitrRestore` to undo. */
    undoBookmark: string;
}

/** Args accepted by {@link armRestore} / the `pitrRestore` admin op. */
interface PitrRestoreArgs {
    /** Restore to an explicit bookmark (e.g. an undo bookmark). Takes precedence over `time`. */
    bookmark?: string;
    /** Also `ctx.abort()` so recovery applies now; otherwise it applies on the next restart. */
    restart?: boolean;
    /** Restore to the bookmark nearest this time (epoch-ms or ISO string), within 30 days. */
    time?: number | string;
}

/** Error thrown when the runtime doesn't expose the native PITR API (local dev / non-SQLite DO). */
const pitrUnavailable = (): Error =>
    Object.assign(
        new Error("native PITR is unavailable here (local dev or a non-SQLite Durable Object); use `lunora backup restore` for off-platform recovery"),
        {
            code: "PITR_UNAVAILABLE",
            name: "LunoraError",
            status: 409,
        },
    );

/** Normalise a time arg (epoch-ms number or ISO string) into what `getBookmarkForTime` accepts. */
const toTime = (time: number | string): Date | number => {
    if (typeof time === "number") {
        return time;
    }

    const parsed = Date.parse(time);

    if (Number.isNaN(parsed)) {
        throw new LunoraError("BAD_REQUEST", `pitr: invalid time "${time}" — expected epoch-ms or an ISO timestamp`);
    }

    return parsed;
};

/**
 * Read the current bookmark, plus (optionally) the bookmark nearest `time`.
 * Non-destructive — used to preview a restore target and to capture an undo
 * point before mutating work.
 */
const readBookmark = async (storage: PitrStorage, time?: number | string): Promise<PitrBookmarkResult> => {
    if (!storage.getCurrentBookmark) {
        throw pitrUnavailable();
    }

    const current = await storage.getCurrentBookmark();

    if (time === undefined || !storage.getBookmarkForTime) {
        return { current };
    }

    return { current, forTime: await storage.getBookmarkForTime(toTime(time)) };
};

/**
 * Arm a point-in-time restore: resolve the target bookmark (from an explicit
 * `bookmark` or the one nearest `time`), tell the runtime to restore to it on
 * next restart, and return the undo bookmark. Does NOT abort — the caller
 * decides whether to restart now (so it can flush a response / audit first).
 */
const armRestore = async (storage: PitrStorage, args: PitrRestoreArgs): Promise<Omit<PitrRestoreResult, "restarted">> => {
    if (!storage.onNextSessionRestoreBookmark) {
        throw pitrUnavailable();
    }

    let target = args.bookmark;

    if (target === undefined) {
        if (args.time === undefined) {
            throw new LunoraError("BAD_REQUEST", "pitrRestore: provide a `bookmark` or a `time` to restore to");
        }

        if (!storage.getBookmarkForTime) {
            throw pitrUnavailable();
        }

        target = await storage.getBookmarkForTime(toTime(args.time));
    }

    const undoBookmark = await storage.onNextSessionRestoreBookmark(target);

    return { restoredTo: target, undoBookmark };
};

export type { PitrBookmarkResult, PitrRestoreArgs, PitrRestoreResult, PitrStorage };
export { armRestore, readBookmark };
