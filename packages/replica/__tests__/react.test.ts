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
// collapsed to `undefined`, indistinguishable from "no data yet". These
// tests exercise the fix: `getSnapshot` reads through `LocalMirror.queryCached`
// so a cache hit needs no SQLite call, and failures surface as `{ error }`.

const makeMirror = (): LocalMirror => new LocalMirror({ db: createBetterSqlite3Adapter(new Database(":memory:")) });

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
});
