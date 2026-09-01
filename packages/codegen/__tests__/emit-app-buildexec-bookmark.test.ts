import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { emitApp } from "../src/emit-app";

/**
 * Plan 336: the D1 bookmark wiring lives in `buildExec`, the module-level
 * helper `emitApp()` emits into every project's `_generated/app.ts`. A prior
 * execution attempt correctly stopped after discovering that the naive fix
 * (just calling `this.getInboundBookmark()` at `buildExec`'s call site) does
 * not compile — see plan 336 §1a. These tests exercise the REAL emitted
 * `buildExec` text (extracted verbatim from `emitApp()`'s output, types
 * stripped, then executed), not a hand-reimplementation — a hand-rolled
 * double would happily keep passing even if the emitter's actual template
 * literal drifted from what these tests assert on.
 */

/** Minimal `EmitAppOptions` with every capability off except `.global()`. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: true,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

/** A minimal double for the structural D1 binding `buildExec` accepts. */
interface FakeD1Database {
    batch?: (statements: unknown[]) => Promise<unknown[]>;
    prepare: (sql: string) => unknown;
    withSession?: (bookmark?: string) => { getBookmark: () => string | null; prepare: (sql: string) => unknown };
}

/** The shape of the `D1Exec` object the real `buildExec` returns. */
interface FakeD1Exec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    batch?: (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>) => Promise<void>;
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<unknown>;
}

type BuildExecFunction = (database: FakeD1Database, bookmark?: string, onBookmark?: (bookmark: string | undefined) => void) => FakeD1Exec;

/**
 * Extract the emitted `buildExec` helper verbatim from `emitApp()`'s real
 * output — the exact text every project's `_generated/app.ts` gets — so the
 * tests below run the actual generated function.
 */
const extractBuildExec = (output: string): string => {
    const start = output.indexOf("const buildExec = (database: D1DatabaseLike");
    const end = output.indexOf("\n\n/** Introspect", start);

    if (start === -1 || end === -1) {
        throw new Error("could not locate buildExec in emitApp() output — did the emitter's buildExec template change shape?");
    }

    return output.slice(start, end);
};

/**
 * Strip `buildExec`'s TS type annotations (an isolated, single-file
 * transpile — no cross-package resolution needed, since the function body
 * touches nothing outside its own parameters) and evaluate it. Mirrors the
 * established `new Function` pattern already used for compiled-validator
 * snippets in `snippet-helpers.ts`.
 */
const compileBuildExec = (source: string): BuildExecFunction => {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } });

    // `retryingExec` wraps the emitted exec but is imported by the generated
    // module rather than declared in the slice above, so it is supplied here as
    // a pass-through. These tests are about session/bookmark wiring; the retry
    // policy has its own coverage in `@lunora/d1`.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- test-only: evaluating the emitter's own real output (types stripped), mirroring snippet-helpers.ts's established pattern
    return new Function("retryingExec", `"use strict";\n${outputText}\nreturn buildExec;`)((exec: unknown) => exec) as BuildExecFunction;
};

/**
 * A `D1PreparedStatement` double. `bind` chains back to the statement (what the
 * real one does), `all` resolves `rows`, `run` reports success. Typed factories
 * rather than inline `vi.fn()` so the doubles are declared once and each mock
 * carries the signature `vitest/require-mock-type-parameters` asks for.
 */
const fakeStatement = (rows: unknown[] = []) => {
    const statement = {
        all: vi.fn<() => Promise<{ results: unknown[] }>>(async () => {
            return { results: rows };
        }),
        // Wired after the literal, not as `() => statement` inside it: a
        // self-referencing initializer leaves TS unable to infer the object's
        // own type (TS7022/TS7024).
        bind: vi.fn<() => unknown>(),
        run: vi.fn<() => Promise<{ success: boolean }>>(async () => {
            return { success: true };
        }),
    };

    statement.bind.mockReturnValue(statement);

    return statement;
};

/** A `withSession(...)` return double: every `prepare` hands back the same statement. */
const fakeSession = (statement: unknown, bookmark = "bookmark-after-write") => {
    return {
        getBookmark: vi.fn<() => string>(() => bookmark),
        prepare: vi.fn<(sql: string) => unknown>(() => statement),
    };
};

describe("emitApp — buildExec real-output bookmark wiring (plan 336)", () => {
    it("a write pins the D1 Sessions API session to the inbound bookmark and reports the write's bookmark via onBookmark", async () => {
        expect.assertions(3);

        const buildExec = compileBuildExec(extractBuildExec(emitApp(baseOptions)));

        const preparedStatement = fakeStatement();
        const session = fakeSession(preparedStatement);
        const withSession = vi.fn<(bookmark?: string) => unknown>(() => session);
        const database: FakeD1Database = { prepare: vi.fn<(sql: string) => unknown>(), withSession } as FakeD1Database;
        const onBookmark = vi.fn<(bookmark: string | undefined) => void>();

        const exec = buildExec(database, "bookmark-inbound", onBookmark);

        await exec.run("insert into settings (id) values (?)", ["s1"]);

        expect(withSession).toHaveBeenCalledWith("bookmark-inbound");
        expect(session.prepare).toHaveBeenCalledWith("insert into settings (id) values (?)");
        expect(onBookmark).toHaveBeenCalledWith("bookmark-after-write");
    });

    /**
     * `all` carries writes, not just reads. D1 runs `UPDATE … RETURNING` through
     * it exactly like `.run()` — `@lunora/d1`'s retry gate says so in as many
     * words — and `@lunora/sql-store`'s optimistic-concurrency compare-and-swap
     * issues precisely that, so `patch`, `replace` and `delete` reach the D1
     * binding through `all` and nowhere else. `run` and `batch` reported their
     * bookmark and `all` did not, so those three writes produced no outbound
     * bookmark at all and the next read could pin a replica that had not seen
     * them: read-your-writes lost on the exact path the bookmark exists for.
     * Only the default configuration was affected — with `cdc: true` a later
     * `run` happened to emit a covering bookmark.
     */
    it("reports the bookmark for an UPDATE … RETURNING, which D1 runs through all() and not run()", async () => {
        expect.assertions(2);

        const buildExec = compileBuildExec(extractBuildExec(emitApp(baseOptions)));

        const preparedStatement = fakeStatement([{ id: "s1" }]);
        const session = fakeSession(preparedStatement, "bookmark-after-occ-swap");
        const withSession = vi.fn<(bookmark?: string) => unknown>(() => session);
        const database: FakeD1Database = { prepare: vi.fn<(sql: string) => unknown>(), withSession } as FakeD1Database;
        const onBookmark = vi.fn<(bookmark: string | undefined) => void>();

        const exec = buildExec(database, "bookmark-inbound", onBookmark);

        const rows = await exec.all(`UPDATE "settings" SET "value" = ? WHERE "id" = ? AND "value" IS ? RETURNING *`, ["b", "s1", "a"]);

        expect(rows).toEqual([{ id: "s1" }]);
        expect(onBookmark).toHaveBeenCalledWith("bookmark-after-occ-swap");
    });

    it("a write then a read on the same exec share one session, so the read is pinned to the write (write-then-read round trip)", async () => {
        expect.assertions(2);

        const buildExec = compileBuildExec(extractBuildExec(emitApp(baseOptions)));

        const preparedStatement = fakeStatement([{ id: "s1" }]);
        const session = fakeSession(preparedStatement);
        const withSession = vi.fn<(bookmark?: string) => unknown>(() => session);
        const database: FakeD1Database = { prepare: vi.fn<(sql: string) => unknown>(), withSession } as FakeD1Database;

        const exec = buildExec(database, "bookmark-inbound");

        await exec.run("insert into settings (id) values (?)", ["s1"]);
        await exec.all("select * from settings where id = ?", ["s1"]);

        // Both statements ran through the ONE session opened for this exec —
        // the read observes the write because they share a session, not
        // because each call re-opened its own (which would silently fall
        // back to "first-unconstrained" per statement and defeat read-your-
        // writes).
        expect(withSession).toHaveBeenCalledTimes(1);
        expect(session.prepare).toHaveBeenCalledTimes(2);
    });

    it("falls back to prepare() directly on the raw binding when it has no withSession (test-double compatibility)", async () => {
        expect.assertions(2);

        const buildExec = compileBuildExec(extractBuildExec(emitApp(baseOptions)));

        const preparedStatement = fakeStatement([{ id: "s1" }]);
        const database: FakeD1Database = { prepare: vi.fn<(sql: string) => unknown>(() => preparedStatement) };

        const exec = buildExec(database);
        const rows = await exec.all("select * from settings", []);

        expect(database.prepare).toHaveBeenCalledWith("select * from settings");
        expect(rows).toEqual([{ id: "s1" }]);
    });
});
