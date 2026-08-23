/**
 * The once-per-window gate the metrics recorders share.
 *
 * Every metrics module writes a per-minute bucket row and then trims the
 * buckets past its retention horizon. The trim is a correlated-subquery `MAX`
 * scan plus a range delete — far too expensive to run on every dispatch, and
 * unnecessary: a window's buckets can only fall out of retention once per
 * window, so the trim only has to fire on the first write into a new one.
 *
 * The marker is keyed by the storage handle rather than a module-level scalar:
 * workerd hosts several Durable Object instances of the same class in one
 * isolate, so a shared scalar lets a busy shard claim the window and every
 * other shard on that isolate skip its prune entirely — the retention bound
 * would then not hold, which is the one thing this gate exists to guarantee. A
 * `WeakMap` means an evicted DO's entry is collected with it.
 *
 * `key` is the SCOPE the caller's delete actually covers. A table-wide trim
 * passes the default; a trim narrowed to one row-group (`WHERE path = ?`) must
 * pass that group, or the first writer of a window claims it for groups it
 * never prunes and their rows grow without bound. Callers cap their own key
 * space (the recorders admit a bounded set of paths), so the inner map is
 * bounded by that cap.
 */
const lastPrunedBucket = new WeakMap<object, Map<string, number>>();

/**
 * Whether `key`'s retention trim should run for `bucket` on this storage
 * handle — true exactly once per `(handle, key, bucket)`. Claims the window as
 * a side effect, so call it directly in the `if` guarding the delete.
 */
const shouldPrune = (sql: object, bucket: number, key = ""): boolean => {
    let byKey = lastPrunedBucket.get(sql);

    if (byKey === undefined) {
        byKey = new Map();
        lastPrunedBucket.set(sql, byKey);
    }

    if (byKey.get(key) === bucket) {
        return false;
    }

    byKey.set(key, bucket);

    return true;
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { shouldPrune };
