import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    claimDevServerState,
    clearDevServerState,
    DEV_STATE_DIR,
    DEV_STATE_FILE,
    isProcessAlive,
    isRecordedProcessCurrent,
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

    it("treats a recycled PID as stale (record predates the process's start)", () => {
        expect.assertions(2);

        // A record claiming this very process started before 1970-01-02 can
        // only be a recycled PID: this process verifiably started later. The
        // start-time guard only runs where /proc exposes it (Linux) — on other
        // platforms liveness alone decides, so assert conditionally.
        const impossiblyOld = { mode: "cli" as const, pid: process.pid, startedAt: "1970-01-02T00:00:00.000Z", url: "http://localhost:8787" };
        const expectStale = process.platform === "linux";

        expect(isRecordedProcessCurrent(impossiblyOld)).toBe(!expectStale);

        writeDevServerState(workdir, impossiblyOld);

        expect(readLiveDevServerState(workdir)?.pid).toBe(expectStale ? undefined : process.pid);
    });

    it("claimDevServerState creates exclusively and reports a live incumbent", () => {
        expect.assertions(5);

        const first = claimDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:8787" });

        expect(first.ok).toBe(true);
        expect(readDevServerState(workdir)?.pid).toBe(process.pid);

        // A second claimant loses to the live incumbent and gets its record.
        const second = claimDevServerState(workdir, { mode: "vite", pid: DEAD_PID, url: "http://localhost:5173" });

        expect(second.ok).toBe(false);
        expect(second.existing?.pid).toBe(process.pid);
        // The incumbent's record is untouched.
        expect(readDevServerState(workdir)?.mode).toBe("cli");
    });

    it("claimDevServerState clears a stale incumbent and claims over it", () => {
        expect.assertions(2);

        writeDevServerState(workdir, { mode: "cli", pid: DEAD_PID, url: "http://localhost:8787" });

        const claim = claimDevServerState(workdir, { mode: "vite", pid: process.pid, url: "http://localhost:5173" });

        expect(claim.ok).toBe(true);
        expect(readDevServerState(workdir)?.pid).toBe(process.pid);
    });

    it("claimDevServerState supersedes exactly the named provisional record", () => {
        expect.assertions(4);

        // The parent CLI's provisional record (a live pid — use our own).
        writeDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:5173" });

        // The spawned server may replace the record it was handed (supersedePid).
        const takeover = claimDevServerState(workdir, { mode: "vite", pid: 99_999, url: "http://localhost:5199" }, { supersedePid: process.pid });

        expect(takeover.ok).toBe(true);
        expect(readDevServerState(workdir)?.url).toBe("http://localhost:5199");

        // A supersedePid that does NOT match the live record still loses.
        writeDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:5173" });

        const stranger = claimDevServerState(workdir, { mode: "vite", pid: 99_999, url: "http://localhost:5199" }, { supersedePid: 12_345 });

        expect(stranger.ok).toBe(false);
        expect(readDevServerState(workdir)?.url).toBe("http://localhost:5173");
    });
});
