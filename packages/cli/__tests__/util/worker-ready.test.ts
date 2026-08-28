import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDevServerState, writeDevServerState } from "@lunora/config";
import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import { markWorkerReadyWhenServing } from "../../src/util/worker-ready";

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

/** A project root carrying the record `lunora dev` claims before spawning the worker. */
const projectWithStartedServer = (): string => {
    const workdir = mkdtempSync(join(tmpdir(), "lunora-ready-"));

    writeDevServerState(workdir, { mode: "cli", pid: process.pid, startedAt: new Date().toISOString(), url: "http://localhost:8787" });

    return workdir;
};

describe("markWorkerReadyWhenServing", () => {
    it("stamps readyAt once the origin answers", async () => {
        expect.assertions(3);

        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();

        try {
            // The record already exists and already has a url + a live pid —
            // that is exactly the state a supervisor cannot tell apart from a
            // serving worker, and what `readyAt` is for.
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();

            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                fetchImpl: async () => new Response("", { status: 404 }),
                logger,
                origin: "http://localhost:8787",
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
            expect(readDevServerState(workdir)?.readyAt).toBeDefined();
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("counts a 404 or 500 as ready — the question is whether anything is listening", async () => {
        expect.assertions(1);

        // A fresh Worker with no root route answers 404. Waiting for a 2xx would
        // leave it reported as never-ready for the life of the dev server.
        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                fetchImpl: async () => new Response("boom", { status: 500 }),
                logger,
                origin: "http://localhost:8787",
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("retries a refused connection instead of giving up on the first attempt", async () => {
        expect.assertions(2);

        // `wrangler dev` does not bind instantly — the first probes land before
        // the port is open, and treating that as failure would mean readyAt is
        // never written for any real project.
        const workdir = projectWithStartedServer();
        const { logger } = silentLogger();
        let attempts = 0;

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                fetchImpl: async () => {
                    attempts += 1;

                    if (attempts < 3) {
                        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
                    }

                    return new Response("", { status: 200 });
                },
                logger,
                origin: "http://localhost:8787",
                signal: new AbortController().signal,
            });

            expect(recorded).toBe(true);
            expect(attempts).toBe(3);
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("stops on abort without stamping readyAt or warning", async () => {
        expect.assertions(3);

        // Teardown aborts it. A probe that outlived the server would keep polling
        // an origin being torn down, and a "did not answer in time" warning on a
        // deliberate shutdown is noise.
        const workdir = projectWithStartedServer();
        const { logger, warns } = silentLogger();
        const controller = new AbortController();

        controller.abort();

        try {
            const recorded = await markWorkerReadyWhenServing({
                cwd: workdir,
                fetchImpl: async () => {
                    throw new Error("should never be called");
                },
                logger,
                origin: "http://localhost:8787",
                signal: controller.signal,
            });

            expect(recorded).toBe(false);
            expect(readDevServerState(workdir)?.readyAt).toBeUndefined();
            expect(warns).toHaveLength(0);
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
                fetchImpl: async () => new Response("", { status: 200 }),
                logger,
                origin: "http://localhost:8787",
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
