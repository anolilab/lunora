// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createBetterSqlite3Adapter } from "../src/adapters/better-sqlite3";
import { LocalMirror } from "../src/local-mirror";
import { useLocalQuery } from "../src/react";
import { createTableDiff } from "../src/table-diff";

// Plan 218: `useLocalQuery` used to run `mirror.query(...)` imperatively in
// the render body, AFTER `useSyncExternalStore` — divorced from React's
// snapshot mechanism. That meant: (1) every re-render re-ran the SQL query
// regardless of whether the mirror actually changed, and (2) a failed query
// collapsed to `undefined`, indistinguishable from "no data yet". The fix:
// `getSnapshot` subscribes to `mirror.version` (a plain, unconditionally
// `Object.is`-stable number) and the actual query runs in a `useMemo` keyed
// on `[mirror, version, sql, paramsKey]`, so a re-render that isn't preceded
// by a mutation is a memo hit, not a fresh query, and a failed query surfaces
// as `{ error }` instead of throwing during render or collapsing to `undefined`.
//
// An earlier version of this fix cached query results inside `LocalMirror`
// itself (`queryCached`, LRU-capped at 64 entries). That cache caused two
// crashes fixed here: (1) with more than 64 distinct live queries on one
// mirror, inserting one hook's entry evicted a still-mounted hook's entry,
// making its next `getSnapshot` return a fresh non-identical object — React
// force-re-rendered it, which re-inserted and evicted another entry, looping
// without bound ("Maximum update depth exceeded"); (2) the cache key was
// built with a plain `JSON.stringify(params)` before the try/catch, so a
// `bigint` param threw synchronously during render. Deriving the result in
// the React layer (no core-side cache, no cap) removes both failure modes.

const makeMirror = (): LocalMirror => new LocalMirror({ db: createBetterSqlite3Adapter(new Database(":memory:")) });

type Todo = { id: string; title: string };
type TodoHookResult = ReturnType<typeof renderHook<ReturnType<typeof useLocalQuery<Todo>>, unknown>>;

describe(useLocalQuery, () => {
    it("returns live query results and does not call mirror.query again on an unrelated re-render", () => {
        const mirror = makeMirror();

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "write tests" }, type: "insert" }]));

        const querySpy = vi.spyOn(mirror, "query");

        const { rerender, result } = renderHook(() => useLocalQuery<{ id: string; title: string }>(mirror, "SELECT id, title FROM todos ORDER BY id"));

        expect(result.current.data).toStrictEqual([{ id: "1", title: "write tests" }]);
        expect(result.current.error).toBeUndefined();

        const callsAfterMount = querySpy.mock.calls.length;

        expect(callsAfterMount).toBeGreaterThan(0);

        // Re-render with nothing changed (same mirror, same sql/params, no
        // mutation in between) — must be served from the mirror's per-version
        // cache, not a fresh SQLite call.
        rerender();
        rerender();

        expect(querySpy).toHaveBeenCalledTimes(callsAfterMount);
        expect(result.current.data).toStrictEqual([{ id: "1", title: "write tests" }]);
    });

    it("surfaces a malformed query as an error instead of collapsing it to undefined", () => {
        const mirror = makeMirror();

        const { result } = renderHook(() => useLocalQuery(mirror, "NOT VALID SQL"));

        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeInstanceOf(Error);
    });

    it("updates data when the mirror advances to a new version", () => {
        const mirror = makeMirror();

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "first" }, type: "insert" }]));

        const { result } = renderHook(() => useLocalQuery<{ id: string; title: string }>(mirror, "SELECT id, title FROM todos ORDER BY id"));

        expect(result.current.data).toStrictEqual([{ id: "1", title: "first" }]);

        act(() => {
            mirror.applyDiff(createTableDiff("todos", [{ data: { id: "2", title: "second" }, type: "insert" }]));
        });

        expect(result.current.data).toStrictEqual([
            { id: "1", title: "first" },
            { id: "2", title: "second" },
        ]);
        expect(result.current.error).toBeUndefined();
    });

    it("re-queries after clearData bumps the version even though nothing was appended to the event log", () => {
        const mirror = makeMirror();

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "first" }, type: "insert" }]));

        const { result } = renderHook(() => useLocalQuery<{ id: string; title: string }>(mirror, "SELECT id, title FROM todos"));

        expect(result.current.data).toStrictEqual([{ id: "1", title: "first" }]);

        act(() => {
            mirror.clearData();
        });

        expect(result.current.data).toStrictEqual([]);
    });

    it("supports many (70) distinct concurrent queries on one mirror without a render loop", () => {
        const mirror = makeMirror();

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "write tests" }, type: "insert" }]));

        const distinctQueryCount = 70;

        // Each `renderHook` call mounts its own independent React root, but
        // all 70 share the SAME mirror — the shape that triggers the old
        // LRU-capped `queryCached` bug: 64 was the cap, so query #65 evicted
        // query #1's cache entry, making #1's next `getSnapshot` return a
        // fresh (non-`Object.is`-equal) object, forcing React to re-render
        // it, re-insert, evict another, and so on without bound. A mount
        // that throws "Maximum update depth exceeded" surfaces as a thrown
        // error out of `renderHook` (wrapped in `act`), so `not.toThrow()`
        // is a real assertion here, not a formality.
        let hooks: TodoHookResult[] = [];

        expect(() => {
            // Offset well clear of the seeded id "1" so every one of the 70
            // distinct queries returns an empty result set, keeping the
            // assertions below uniform across all of them.
            hooks = Array.from({ length: distinctQueryCount }, (_unused, index) =>
                renderHook(() => useLocalQuery<Todo>(mirror, "SELECT id, title FROM todos WHERE id = ?", [String(index + 1000)])),
            );
        }).not.toThrow();

        expect(hooks).toHaveLength(distinctQueryCount);

        for (const { result } of hooks) {
            expect(result.current.error).toBeUndefined();
            expect(result.current.data).toStrictEqual([]);
        }

        // Re-render every hook with nothing changed (no mutation in
        // between) — must not perturb any other hook's snapshot and must
        // not throw. `getSnapshot` now reads `mirror.version`, a plain
        // number with no cap and no eviction, so it can't happen here.
        expect(() => {
            for (const { rerender } of hooks) {
                rerender();
            }
        }).not.toThrow();

        for (const { result } of hooks) {
            expect(result.current.error).toBeUndefined();
            expect(result.current.data).toStrictEqual([]);
        }
    });

    it("does not crash render on a bigint param (returns data or a typed error, never throws)", () => {
        const mirror = makeMirror();

        mirror.applyDiff(createTableDiff("todos", [{ data: { id: "1", title: "write tests" }, type: "insert" }]));

        // Plain `JSON.stringify` throws `TypeError: Do not know how to
        // serialize a BigInt` — a naive params-key builder would throw this
        // synchronously during render (crashing the subtree) for a bigint
        // param, which is a normal bind value for 64-bit SQLite ids.
        let outcome: TodoHookResult | undefined;

        expect(() => {
            outcome = renderHook(() => useLocalQuery<Todo>(mirror, "SELECT id, title FROM todos WHERE id = ?", [123n]));
        }).not.toThrow();

        expect(outcome).toBeDefined();
        // Never both undefined — the union always resolves to `{ data }` or `{ error }`.
        expect(outcome?.result.current.data !== undefined || outcome?.result.current.error !== undefined).toBe(true);
        expect(outcome?.result.current.data).toStrictEqual([]);
        expect(outcome?.result.current.error).toBeUndefined();
    });
});
