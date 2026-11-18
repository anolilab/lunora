import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDevServerState } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLocalLogsCommand } from "../../src/commands/logs/local";
import type { Logger } from "../../src/util/logger";

const logger: Logger = { error: () => undefined, info: () => undefined, success: () => undefined, warn: () => undefined };

const empty = (): Promise<Response> => Promise.resolve(Response.json({ errors: [], result: { columns: [], rows: [] }, success: true }));

describe("lunora logs --local: which dev server it reads", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-logs-local-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reads the running standalone `lunora dev` server recorded in dev.json, not Vite's port", async () => {
        expect.assertions(1);

        writeDevServerState(workdir, { mode: "cli", pid: process.pid, startedAt: new Date().toISOString(), url: "http://localhost:8787" });
        const fetch = vi.fn<typeof globalThis.fetch>(empty);

        await runLocalLogsCommand({ cwd: workdir, fetch, logger });

        expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:8787/cdn-cgi/local/explorer/api/local/observability/query");
    });

    it("lets --url win over the recorded server", async () => {
        expect.assertions(1);

        writeDevServerState(workdir, { mode: "cli", pid: process.pid, startedAt: new Date().toISOString(), url: "http://localhost:8787" });
        const fetch = vi.fn<typeof globalThis.fetch>(empty);

        await runLocalLogsCommand({ cwd: workdir, fetch, logger, url: "http://localhost:9000" });

        expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:9000/cdn-cgi/local/explorer/api/local/observability/query");
    });

    it("falls back to Vite's default port when no dev server is recorded", async () => {
        expect.assertions(1);

        const fetch = vi.fn<typeof globalThis.fetch>(empty);

        await runLocalLogsCommand({ cwd: workdir, fetch, logger });

        expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:5173/cdn-cgi/local/explorer/api/local/observability/query");
    });
});
