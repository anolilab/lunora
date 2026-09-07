import { fnv1a64Hex } from "../../../shared/fnv1a";
import { stableWireKey } from "../../../shared/wire-key";
import type { TableDiff } from "./table-diff";

/**
 * Derive a deterministic id for an id-less insert, from the row's CONTENT.
 *
 * A random `crypto.randomUUID()` here would make replay non-deterministic:
 * re-applying the exact same {@link TableDiff} twice (e.g. once live, once on
 * catch-up replay from the event log) would mint two DIFFERENT row keys for
 * the same logical row, leaving duplicate rows / divergent replicas
 * (REPLICA-05).
 *
 * Content is the identity, not the diff that carried it. `subscribeToMirror`
 * re-emits an un-keyed row (an aggregate, or a projection that drops the pk) on
 * EVERY frame and stamps each frame with `Date.now()`; a digest over the diff's
 * `id`/`timestamp` and the change's position therefore minted a fresh key per
 * frame, so a shard writing once a second grew the mirror by ~86,400 rows a day
 * and every read returned the whole history. Over the row's own data instead,
 * a repeated frame upserts onto the key it already wrote.
 *
 * Two consequences, both deliberate. Two id-less inserts carrying identical
 * `data` collapse onto one row, in one diff or across diffs — nothing downstream
 * can tell such rows apart, the next frame included, so one row is the only
 * answer that stays stable. And an un-keyed row whose content CHANGES lands
 * beside its predecessor rather than replacing it: it is a different key, and
 * `subscribeToMirror` never records un-keyed rows in `known`, so no delete is
 * ever derived for the old one. That leaves a residue bounded by the number of
 * distinct contents rather than by frames, which is the difference between a leak
 * and a table that grows without limit.
 *
 * `table` stays in the digest and is interpolated (not concatenated as parts)
 * because it is declared `string` but arrives as untyped JSON over the poke
 * protocol — a template literal coerces a stray number into the digest instead
 * of contributing nothing to it. Covered in `apply-diff-canonical.test.ts`.
 *
 * ## Why the content is encoded with `stableWireKey`
 *
 * The rows reaching here have already been through `decodeWire`, so a column can
 * hold a real `bigint`, `Date`, `URL`, `Map`, `Set`, `ArrayBuffer` or typed-array
 * view. A plain JSON encoding of that decoded tree is not an identity: every
 * value with no own enumerable key renders as `{}`, so a `Date`, a `URL`, a
 * `Map`, a `Set`, an `ArrayBuffer` and a literal `{}` all shared ONE digest and
 * therefore one mirror row — the upsert that this content-keying exists to make
 * possible was overwriting unrelated rows. `NaN`/`±Infinity` collapsed onto
 * `null` the same way, a typed array aliased the plain object with the same
 * indices, and a `bigint` did not hash at all: `JSON.stringify` threw, which in
 * `applyDiffToDb` happens inside `database.transaction` and discards every
 * well-keyed row in the batch.
 *
 * `stableWireKey` (`shared/wire-key.ts`) is `encodeWire` composed with
 * `stableStringify`, which is exactly the fix: the wire form separates every
 * value the wire can carry, and the stable encoding sorts object keys by UTF-16
 * code unit — locale-independent, so two clients in different locales still
 * derive the SAME id for the same row (REPLICA-05; a `localeCompare` comparator
 * is the bug, not the fix). It is also already what `subscribeToMirror` keys its
 * `known` map with, so the keyed and un-keyed paths now agree on what "the same
 * row content" means instead of using two different encodings.
 *
 * `encodeWire` still refuses what the wire itself refuses — a `RegExp`, a class
 * instance, a cyclic graph — with a `TypeError`. Such a value cannot have
 * arrived over the poke protocol (it could not have been encoded to send), and
 * for a locally-built diff a loud throw beats the silent `{}` collision it used
 * to get.
 *
 * MIGRATION: derived ids change for any row holding one of the values above,
 * and are unchanged for pure-JSON rows (`encodeWire` is identity for those, and
 * `stableStringify` agrees byte for byte with a key-sorted `JSON.stringify`).
 * Nothing in this repo persists them and both exports are `@experimental`.
 */
const deriveInsertId = (diff: Pick<TableDiff, "table">, data: Record<string, unknown>): string => `row-${fnv1a64Hex(`${diff.table}::${stableWireKey(data)}`)}`;

/**
 * Apply a diff's changes onto `target` **in place**.
 *
 * The copy-on-apply contract lives in the exported {@link applyDiff}; keeping
 * the mutation itself separate lets {@link applyDiffs} fold a whole backlog
 * into one map with a single copy up front instead of one copy per diff.
 */
const applyDiffInto = (target: Map<string, Record<string, unknown>>, diff: TableDiff): void => {
    for (const change of diff.changes) {
        switch (change.type) {
            case "delete": {
                target.delete(change.id);
                break;
            }
            case "insert": {
                // Insert uses the row data itself (id may or may not be inside
                // data). `bigint` belongs with the other two: the wire decoder
                // hands one back for an int64 column, and rejecting it derived a
                // content hash for a row that HAS a key — the SQLite path in
                // `diff-applier.ts` accepts it, so the two disagreed on where the
                // same row lands. This map is keyed by `id` by contract, so it has
                // no equivalent of that path's configurable `pkColumn`; a table
                // with a differently-named primary key is mirrored through
                // `applyDiffToDb`, not through here.
                const rawId = (change.data as { id?: unknown }).id;
                const id =
                    typeof rawId === "bigint" || typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : deriveInsertId(diff, change.data);

                target.set(id, { ...change.data, id });
                break;
            }
            case "update": {
                const existing = target.get(change.id);

                if (existing) {
                    target.set(change.id, { ...existing, ...change.data });
                }
                // Silently skip updates to unknown rows (race: row was
                // deleted locally before the update arrived).
                break;
            }
            default: {
                break;
            }
        }
    }
};

/**
 * Apply a single {@link TableDiff} to an in-memory row map and return
 * the updated map.
 *
 * The function creates a **shallow copy** of the input map so the caller's
 * reference stays untouched unless they choose to replace it.
 * @example
 * ```ts
 * const rows = new Map<string, Record<string, unknown>>();
 * rows.set("id-1", { name: "alice" });
 *
 * const diff = createTableDiff("users", [
 *   { type: "insert", data: { id: "id-2", name: "bob" } },
 *   { type: "update", id: "id-1", data: { name: "alice-updated" } },
 * ]);
 *
 * const updated = applyDiff(rows, diff);
 * updated.get("id-1")?.name // "alice-updated"
 * updated.get("id-2")?.name // "bob"
 * ```
 * @experimental
 */
const applyDiff = (current: ReadonlyMap<string, Record<string, unknown>>, diff: TableDiff): Map<string, Record<string, unknown>> => {
    const next = new Map(current);

    applyDiffInto(next, diff);

    return next;
};

/**
 * Apply an array of diffs **in order**, returning the final row map.
 *
 * This is equivalent to calling {@link applyDiff} repeatedly but copies the
 * input map exactly once rather than once per diff — catch-up replay of an
 * N-diff backlog is a single copy, not N+1.
 * @experimental
 */
const applyDiffs = (current: ReadonlyMap<string, Record<string, unknown>>, diffs: ReadonlyArray<TableDiff>): Map<string, Record<string, unknown>> => {
    const result = new Map(current);

    for (const diff of diffs) {
        applyDiffInto(result, diff);
    }

    return result;
};

/**
 * Merge the row-level effect of a {@link TableDiff} into plain JSON
 * state keyed by table name, returning a new snapshot.
 * @param snapshot Current snapshot, e.g. `{ users: Map<id, row>, posts: Map<id, row> }`.
 * @param diff Contains the target table name and the row-level changes to merge.
 * @returns A shallow copy of `snapshot` with `diff.table`'s map updated.
 * @experimental
 */
const applyDiffToSnapshot = (
    snapshot: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>,
    diff: TableDiff,
): Map<string, Map<string, Record<string, unknown>>> => {
    // Shallow copy — untouched tables keep the caller's row maps (shared by
    // reference, matching the documented shallow-copy contract). The cast widens
    // the readonly inner-map type to the mutable return type; the values are real
    // `Map`s at runtime, and the one table we replace gets a fresh map anyway.
    const next = new Map(snapshot) as Map<string, Map<string, Record<string, unknown>>>;

    const tableMap = next.get(diff.table) ?? new Map<string, Record<string, unknown>>();

    next.set(diff.table, applyDiff(tableMap, diff));

    return next;
};

export { applyDiff, applyDiffs, applyDiffToSnapshot };

/*
 * Internals, exported for the bench and test suites ONLY — `src/index.ts` does
 * not re-export them, so they are not package API.
 *
 * They are exported rather than left module-private because the alternative is
 * worse: a bench that hand-copies the function it claims to measure silently
 * becomes a fossil the moment the real one is edited, and then reports "no
 * regression" forever. That is exactly the failure the `lintNamed` guard in
 * `@lunora/advisor`'s bench exists to prevent, so the same standard applies here.
 */
export { deriveInsertId };
// Re-exported (not redefined) so the bench and tests measure/pin the ONE
// implementation in `shared/fnv1a.ts` that `@lunora/notify` and `@lunora/agent`
// also call.
export { fnv1a64Hex } from "../../../shared/fnv1a";
