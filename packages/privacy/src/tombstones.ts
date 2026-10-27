/**
 * Tombstones for restores (plan 468, WS J). A backup taken before an erasure still
 * holds the erased subject's rows. When that backup is restored, the subject has to
 * be erased again. A tombstone records that an erasure happened, keyed by an HMAC of
 * the subject id, so the tombstone table holds no raw identifier and a leaked table
 * cannot be matched against a list of guessed ids without the secret.
 */
import { createHmac } from "node:crypto";

import { LunoraError } from "@lunora/errors";

/**
 * The tombstone key for a subject: HMAC-SHA256 of the id under the app's secret, as
 * lowercase hex. `node:crypto` is available to every Lunora app, because the scaffold
 * sets `nodejs_compat`.
 */
const tombstoneKeyOf = (subjectId: string, secret: string): string => {
    // An empty id would key one tombstone that matches every empty id.
    if (subjectId.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "A tombstone needs a non-empty subject id.");
    }

    return createHmac("sha256", secret).update(subjectId).digest("hex");
};

/**
 * The storage the tombstones need. Keep it outside the database a restore rolls back: a tombstone
 * restored away with the data it guards would let the restore bring the erased subject back.
 */
interface TombstonePort {
    /**
     * Record that the subject was erased at this time. Must be an idempotent upsert keyed by `key`:
     * a workflow step that fails after the write is retried and writes the same tombstone again, and a
     * second row for one key must not appear.
     */
    readonly add: (key: string, erasedAt: Date) => Promise<void>;
    /** Whether one key is on record. Answers for one subject without listing every tombstone. */
    readonly has: (key: string) => Promise<boolean>;
    /** Every tombstone key on record. */
    readonly keys: () => Promise<ReadonlySet<string>>;
}

/**
 * The subject ids in a restored backup that were erased after it was taken, so they
 * must be erased again. A row whose subject is not tombstoned is left alone.
 */
const subjectsToReerase = async (restoredSubjectIds: ReadonlyArray<string>, tombstones: TombstonePort, secret: string): Promise<ReadonlyArray<string>> => {
    const keys = await tombstones.keys();
    const pending: string[] = [];

    for (const subjectId of new Set(restoredSubjectIds)) {
        if (keys.has(tombstoneKeyOf(subjectId, secret))) {
            pending.push(subjectId);
        }
    }

    return pending;
};

export { subjectsToReerase, tombstoneKeyOf };
export type { TombstonePort };
