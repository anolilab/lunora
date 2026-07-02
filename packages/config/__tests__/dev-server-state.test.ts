import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    clearDevServerState,
    DEV_STATE_DIR,
    DEV_STATE_FILE,
    isProcessAlive,
    readDevServerState,
    readLiveDevServerState,
    updateDevServerState,
    writeDevServerState,
} from "../src/dev-server-state";

/** A PID that is effectively never alive: beyond every platform's pid_max. */
const DEAD_PID = 2 ** 30;

describe("dev-server-state", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-dev-state-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("round-trips a written state, creating .lunora/ on demand", () => {
        expect.assertions(2);

        const path = writeDevServerState(workdir, {
            background: true,
            logFile: join(workdir, "dev.log"),
            mode: "cli",
            pid: 4321,
            startedAt: "2026-01-01T00:00:00.000Z",
            studioUrl: "http://127.0.0.1:6173",
            url: "http://localhost:8787",
        });

        expect(path).toBe(join(workdir, DEV_STATE_FILE));
        expect(readDevServerState(workdir)).toStrictEqual({
            background: true,
            logFile: join(workdir, "dev.log"),
            mode: "cli",
            pid: 4321,
            startedAt: "2026-01-01T00:00:00.000Z",
            studioUrl: "http://127.0.0.1:6173",
            url: "http://localhost:8787",
        });
    });

    it("returns undefined for a missing state file", () => {
        expect.assertions(1);

        expect(readDevServerState(workdir)).toBeUndefined();
    });

    it("returns undefined for malformed JSON or a record missing pid/url", () => {
        expect.assertions(2);

        writeDevServerState(workdir, { mode: "vite", pid: 1, url: "http://localhost:5173" });
        writeFileSync(join(workdir, DEV_STATE_DIR, "dev.json"), "{ not json", "utf8");

        expect(readDevServerState(workdir)).toBeUndefined();

        writeFileSync(join(workdir, DEV_STATE_DIR, "dev.json"), JSON.stringify({ pid: 1 }), "utf8");

        expect(readDevServerState(workdir)).toBeUndefined();
    });

    it("clearDevServerState is idempotent and honours expectedPid", () => {
        expect.assertions(3);

        writeDevServerState(workdir, { mode: "cli", pid: 111, url: "http://localhost:8787" });

        // A stale server (pid 222) must not clobber the newer record (pid 111).
        clearDevServerState(workdir, 222);

        expect(readDevServerState(workdir)?.pid).toBe(111);

        clearDevServerState(workdir, 111);

        expect(readDevServerState(workdir)).toBeUndefined();

        // Clearing again (nothing on disk) must not throw.
        clearDevServerState(workdir);

        expect(readDevServerState(workdir)).toBeUndefined();
    });

    it("updateDevServerState merges a patch into the existing record", () => {
        expect.assertions(3);

        expect(updateDevServerState(workdir, { background: true })).toBeUndefined();

        writeDevServerState(workdir, { mode: "vite", pid: 7, url: "http://localhost:5173" });

        const merged = updateDevServerState(workdir, { background: true, logFile: join(workdir, "dev.log") });

        expect(merged?.background).toBe(true);
        expect(readDevServerState(workdir)?.logFile).toBe(join(workdir, "dev.log"));
    });

    it("isProcessAlive: own pid is alive, an impossible pid is not", () => {
        expect.assertions(3);

        expect(isProcessAlive(process.pid)).toBe(true);
        expect(isProcessAlive(DEAD_PID)).toBe(false);
        expect(isProcessAlive(-1)).toBe(false);
    });

    it("readLiveDevServerState returns a live record and clears a stale one", () => {
        expect.assertions(3);

        writeDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:8787" });

        expect(readLiveDevServerState(workdir)?.pid).toBe(process.pid);

        writeDevServerState(workdir, { mode: "cli", pid: DEAD_PID, url: "http://localhost:8787" });

        expect(readLiveDevServerState(workdir)).toBeUndefined();
        // The stale record was removed on the spot.
        expect(readDevServerState(workdir)).toBeUndefined();
    });
});
