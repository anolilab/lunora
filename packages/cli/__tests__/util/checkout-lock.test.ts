import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireCheckoutLock } from "../../src/util/checkout-lock";

/** Beyond any real pid range, so `process.kill(pid, 0)` reports no such process. */
const DEAD_PID = 2_147_483_646;

describe("acquireCheckoutLock", () => {
    let workdir: string;
    let lockPath: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-lock-"));
        lockPath = join(workdir, ".lunora", "preview.lock");
        mkdirSync(join(workdir, ".lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("exports by name only, as the repository's export rule requires", () => {
        expect.assertions(1);

        expect(readFileSync(join(import.meta.dirname, "..", "..", "src", "util", "checkout-lock.ts"), "utf8")).not.toMatch(/^export default /mu);
    });

    it("takes the lock whole, refuses a second taker while it is held, and lets go on release", () => {
        expect.assertions(4);

        const first = acquireCheckoutLock(workdir);

        expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
        expect(acquireCheckoutLock(workdir).error).toMatch(/another preview command is running/u);

        first.release?.();

        expect(existsSync(lockPath)).toBe(false);
        expect(acquireCheckoutLock(workdir).error).toBeUndefined();
    });

    it("takes over a lock whose process is gone", () => {
        expect.assertions(2);

        writeFileSync(lockPath, String(DEAD_PID));

        expect(acquireCheckoutLock(workdir).error).toBeUndefined();
        expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });

    it("does not remove a live lock a faster taker put in place after this one read the dead owner", () => {
        expect.assertions(3);

        writeFileSync(lockPath, String(DEAD_PID));

        const result = acquireCheckoutLock(workdir, {
            // The other taker finishes its takeover here: the dead lock is gone and a live one is in its place.
            afterReadingOwner: () => {
                unlinkSync(lockPath);
                writeFileSync(lockPath, String(process.ppid));
            },
        });

        expect(result.error).toMatch(/taking over the lock/u);
        expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
        expect(existsSync(`${lockPath}.retire-${String(DEAD_PID)}`)).toBe(false);
    });

    it("leaves the lock alone while another taker holds the right to retire it", () => {
        expect.assertions(2);

        writeFileSync(lockPath, String(DEAD_PID));
        writeFileSync(`${lockPath}.retire-${String(DEAD_PID)}`, String(DEAD_PID));

        expect(acquireCheckoutLock(workdir).error).toMatch(/taking over the lock/u);
        expect(readFileSync(lockPath, "utf8")).toBe(String(DEAD_PID));
    });

    it("never releases a lock that is no longer its own", () => {
        expect.assertions(1);

        const mine = acquireCheckoutLock(workdir);

        unlinkSync(lockPath);
        writeFileSync(lockPath, String(process.ppid));
        mine.release?.();

        expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
    });
});
