import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDevServerState, writeDevServerState } from "@lunora/config";
import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import markWorkerReadyWhenServing from "../../src/util/worker-ready";

const silentLogger = (): { logger: Logger; warns: string[] } => {
    const warns: string[] = [];

    return {
        logger: {
            error: () => {},
            info: () => {},
            success: () => {},
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

/** A project root carrying the record the CLI claims before spawning the server. */
const projectWithStartedServer = (pid = process.pid): string => {
    const workdir = mkdtempSync(join(tmpdir(), "lunora-ready-"));

    writeDevServerState(workdir, { mode: "cli", pid, startedAt: new Date().toISOString(), url: "http://localhost:8787" });

    return workdir;
};

describe("markWorkerReadyWhenServing", () => {
    it("stamps readyAt once the probe answers", async () => {
        expect.assertions(3);

        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();

        try {
            // The record already has a url and a live pid — exactly the state a
            // supervisor cannot tell apart from a serving server.
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();

            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => true,
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
            expect(readDevServerState(workdir)?.readyAt).toBeDefined();
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("keeps polling while the probe says no, rather than giving up on the first attempt", async () => {
        expect.assertions(2);

        // `wrangler dev` does not bind instantly, so the first probes land before
        // the port is open. Treating that as failure would mean readyAt is never
        // written for any real project.
        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();
        let attempts = 0;

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => {
                    attempts += 1;

                    return attempts >= 3;
                },
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
            expect(attempts).toBe(3);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("stops when aborted MID-WAIT, without stamping or warning", async () => {
        expect.assertions(3);

        // The real teardown shape: the probe is already looping when the server
        // shuts down. Aborting before the call would only exercise the loop
        // guard and never the interruptible sleep, which is the whole reason the
        // signal is threaded into it.
        const workdir = projectWithStartedServer();
        const { logger, warns } = silentLogger();
        const controller = new AbortController();
        let attempts = 0;

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => {
                    attempts += 1;
                    controller.abort();

                    return false;
                },
                signal: controller.signal,
            });

            expect(recorded).toBe(false);
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();
            // A warning on a deliberate shutdown is noise, not a diagnostic.
            expect(warns).toHaveLength(0);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("gives up on its own deadline and says why", async () => {
        expect.assertions(3);

        // A server that never binds must not leave the probe running for the life
        // of the dev session, and the give-up has to be visible — this is the
        // path that reports "your supervisor will wait forever".
        const workdir = projectWithStartedServer();
        const { logger, warns } = silentLogger();

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => false,
                readyTimeoutMs: 1,
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(false);
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();
            expect(warns.join(" ")).toContain("LUNORA_DEV_READY_TIMEOUT_MS");
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("survives a probe that rejects, rather than becoming an unhandled rejection", async () => {
        expect.assertions(2);

        // "Never rejects" is this function's contract, not its collaborator's,
        // and the caller floats the promise — so a throwing probe would surface
        // as an unhandled rejection that takes down the dev server it only meant
        // to observe.
        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();
        let attempts = 0;

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => {
                    attempts += 1;

                    if (attempts === 1) {
                        throw new Error("probe blew up");
                    }

                    return true;
                },
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
            expect(attempts).toBe(2);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("does not stamp a record another process has since claimed", async () => {
        expect.assertions(2);

        // A late answer from THIS server must not mark a NEWER server ready. The
        // record is replaced wholesale on a new claim, so without the pid guard
        // the stamp lands on whoever holds it now.
        const workdir = projectWithStartedServer(process.pid + 1);
        const { logger } = silentLogger();

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => true,
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(false);
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("leaves the rest of the record untouched", async () => {
        expect.assertions(2);

        // It patches one field onto a record another writer owns; clobbering the
        // pid or url would break `lunora dev stop`.
        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();

        try {
            await markWorkerReadyWhenServing({
                cwd: workdir,
                logger,
                origin: "http://localhost:8787",
                probe: async () => true,
                signal: new AbortController().signal,
            });

            const state = readDevServerState(workdir);

            expect(state?.pid).toBe(process.pid);
            expect(state?.url).toBe("http://localhost:8787");
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });
});
