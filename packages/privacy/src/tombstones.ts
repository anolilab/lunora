/**
 * Tombstones for restores (plan 468, WS J). A backup taken before an erasure still
 * holds the erased subject's rows. When that backup is restored, the subject has to
 * be erased again. A tombstone records that an erasure happened, keyed by a hash of
 * the subject id, so the tombstone table holds no raw identifier.
 */
import { createHash } from "node:crypto";

import { LunoraError } from "@lunora/errors";

/**
 * The tombstone key for a subject: SHA-256 of the id, as lowercase hex. `node:crypto`
 * is available to every Lunora app, because the scaffold sets `nodejs_compat`.
 */
const tombstoneKeyOf = (subjectId: string): string => createHash("sha256").update(subjectId).digest("hex");

/** The storage the tombstones need. The app implements it over its `privacy_tombstones` table. */
interface TombstonePort {
    /** Record that the subject was erased at this time. */
    readonly add: (key: string, erasedAt: Date) => Promise<void>;
    /** Every tombstone key on record. */
    readonly keys: () => Promise<ReadonlySet<string>>;
}

/**
 * The subject ids in a restored backup that were erased after it was taken, so they
 * must be erased again. A row whose subject is not tombstoned is left alone.
 */
const subjectsToReerase = async (restoredSubjectIds: ReadonlyArray<string>, tombstones: TombstonePort): Promise<ReadonlyArray<string>> => {
    const keys = await tombstones.keys();
    const pending: string[] = [];

    for (const subjectId of new Set(restoredSubjectIds)) {
        if (keys.has(tombstoneKeyOf(subjectId))) {
            pending.push(subjectId);
        }
    }

    return pending;
};

/** Refuse a subject id that is empty, since its tombstone key would match every empty id. */
const assertSubjectId = (subjectId: string): void => {
    if (subjectId.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "A tombstone needs a non-empty subject id.");
    }
};

export { assertSubjectId, subjectsToReerase, tombstoneKeyOf };
export type { TombstonePort };
