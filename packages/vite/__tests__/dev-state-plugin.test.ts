import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDevServerState, writeDevServerState } from "@lunora/config";
import type { Plugin, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import devStatePlugin from "../src/dev-state-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

/** A controllable mock of the ViteDevServer subset the plugin touches. */
interface MockServer {
    close: () => void;
    listen: () => void;
    server: ViteDevServer;
    warnings: string[];
}

const createMockServer = (url = "http://localhost:5173/"): MockServer => {
    const listeners = new Map<string, (() => void)[]>();
    const warnings: string[] = [];

    const httpServer = {
        address: () => {
            return { address: "127.0.0.1", family: "IPv4", port: 5173 };
        },
        once: (event: string, callback: () => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), callback]);
        },
    };

    const server = {
        config: {
            logger: {
                warn: (message: string) => {
                    warnings.push(message);
                },
            },
        },
        httpServer,
        printUrls: () => {},
        resolvedUrls: { local: [url], network: [] },
    } as unknown as ViteDevServer;

    return {
        close: () => {
            for (const callback of listeners.get("close") ?? []) {
                callback();
            }
        },
        listen: () => {
            for (const callback of listeners.get("listening") ?? []) {
                callback();
            }
        },
        server,
        warnings,
    };
};

/** Run the plugin's configureServer + its returned post hook against the mock. */
const configure = (plugin: Plugin, server: ViteDevServer): void => {
    const hook = plugin.configureServer;
    const fn = typeof hook === "function" ? hook : hook?.handler;
    const post = fn?.call(plugin as never, server) as (() => void) | undefined;

    post?.();
};

const options = (root: string): ResolvedLunoraPluginOptions => ({ projectRoot: root }) as ResolvedLunoraPluginOptions;

describe("devStatePlugin", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-dev-state-"));
        vi.stubEnv("LUNORA_DEV_DAEMON", "");
        vi.stubEnv("LUNORA_DEV_HANDOFF_PID", "");
        vi.stubEnv("LUNORA_DEV_LOG_FILE", "");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("only applies in serve mode", () => {
        expect.assertions(1);

        expect(devStatePlugin(options(workdir)).apply).toBe("serve");
    });

    it("records the resolved URL + pid via the printUrls wrap and clears on close", () => {
        expect.assertions(4);

        const mock = createMockServer();

        configure(devStatePlugin(options(workdir)), mock.server);

        // The record is written when Vite prints its banner (printUrls).
        mock.server.printUrls();

        const state = readDevServerState(workdir);

        expect(state?.mode).toBe("vite");
        expect(state?.pid).toBe(process.pid);
        // Trailing slash trimmed so consumers can append paths.
        expect(state?.url).toBe("http://localhost:5173");

        mock.close();

        expect(readDevServerState(workdir)).toBeUndefined();
    });

    it("records the daemon marker + log file from the detach env", () => {
        expect.assertions(2);

        vi.stubEnv("LUNORA_DEV_DAEMON", "1");
        vi.stubEnv("LUNORA_DEV_LOG_FILE", join(workdir, ".lunora", "dev.log"));

        const mock = createMockServer();

        configure(devStatePlugin(options(workdir)), mock.server);
        mock.server.printUrls();

        const state = readDevServerState(workdir);

        expect(state?.background).toBe(true);
        expect(state?.logFile).toBe(join(workdir, ".lunora", "dev.log"));
    });

    it("falls back to the listening event when printUrls never fires", async () => {
        expect.assertions(1);

        const mock = createMockServer();

        configure(devStatePlugin(options(workdir)), mock.server);
        mock.listen();

        // The listening fallback records on a macrotask hop.
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });

        expect(readDevServerState(workdir)?.mode).toBe("vite");
    });

    it("never clobbers another live server's record", () => {
        expect.assertions(3);

        // A record owned by a different, live process (the test runner's parent).
        writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:8787" });

        const mock = createMockServer();

        configure(devStatePlugin(options(workdir)), mock.server);
        mock.server.printUrls();

        expect(readDevServerState(workdir)?.pid).toBe(process.ppid);
        expect(mock.warnings.some((line) => line.includes("already recorded"))).toBe(true);

        // Close must not remove the other server's record either.
        mock.close();

        expect(readDevServerState(workdir)?.pid).toBe(process.ppid);
    });

    it("middleware mode (no httpServer): buildEnd clears the record via the pending-close fallback", () => {
        expect.assertions(2);

        // `server.middlewareMode: true` forces `server.httpServer` to `null`, so
        // there is no "close" event to register against — the plugin falls back
        // to `pendingMiddlewareClears`, keyed by the "client" Environment and
        // fired from the `buildEnd` hook (see the map in dev-state-plugin.ts).
        const clientEnvironment = {};
        const server = {
            config: { logger: { warn: () => {} } },
            environments: { client: clientEnvironment },
            printUrls: () => {},
            resolvedUrls: { local: ["http://localhost:5173/"], network: [] },
        } as unknown as ViteDevServer;

        const plugin = devStatePlugin(options(workdir));

        configure(plugin, server);

        // Middleware mode has no httpServer "listening" event to fall back to —
        // the printUrls wrap is the only record trigger available here.
        server.printUrls();

        expect(readDevServerState(workdir)?.mode).toBe("vite");

        (plugin.buildEnd as (this: { environment: unknown }) => void).call({ environment: clientEnvironment });

        expect(readDevServerState(workdir)).toBeUndefined();
    });

    it("supersedes the parent CLI's provisional record named via LUNORA_DEV_HANDOFF_PID", () => {
        expect.assertions(3);

        // The parent CLI (posed by the test runner's live parent) claimed a
        // provisional record before spawning Vite and handed its PID down.
        writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:5173" });
        vi.stubEnv("LUNORA_DEV_HANDOFF_PID", String(process.ppid));

        const mock = createMockServer();

        configure(devStatePlugin(options(workdir)), mock.server);
        mock.server.printUrls();

        // The provisional record is replaced with the authoritative one.
        const state = readDevServerState(workdir);

        expect(state?.pid).toBe(process.pid);
        expect(state?.mode).toBe("vite");
        expect(mock.warnings).toHaveLength(0);
    });
});
