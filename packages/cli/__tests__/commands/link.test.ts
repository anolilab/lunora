import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LINKED_PROJECT_FILE } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLinkCommand } from "../../src/commands/link/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): { errors: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        logger: {
            error: (message) => errors.push(message),
            info: () => {},
            success: () => {},
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

describe("lunora link", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-link-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("writes .lunora/project.json with the worker url, env, and a deterministic linkedAt", () => {
        expect.assertions(4);

        const { logger } = silentLogger();
        const result = runLinkCommand({
            cwd: workdir,
            env: "production",
            logger,
            name: "my-worker",
            now: () => "2026-01-01T00:00:00.000Z",
            url: "https://app.acme.workers.dev",
        });

        expect(result.code).toBe(0);

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://app.acme.workers.dev");
        expect(written.env).toBe("production");
        expect(written.linkedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("defaults the worker name from wrangler config when --name is omitted", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ name: "from-wrangler" }), "utf8");

        const { logger } = silentLogger();

        runLinkCommand({ cwd: workdir, logger, url: "https://x.workers.dev" });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerName).toBe("from-wrangler");
    });

    it("rejects a missing --url", () => {
        expect.assertions(2);

        const { errors, logger } = silentLogger();
        const result = runLinkCommand({ cwd: workdir, logger });

        expect(result.code).toBe(1);
        expect(errors.some((line) => line.includes("--url"))).toBe(true);
    });

    it("rejects an invalid --url without writing", () => {
        expect.assertions(2);

        const { logger } = silentLogger();
        const result = runLinkCommand({ cwd: workdir, logger, url: "not-a-url" });

        expect(result.code).toBe(1);
        expect(existsSync(join(workdir, LINKED_PROJECT_FILE))).toBe(false);
    });

    it("--remove deletes the link, and is a no-op (warn) when none exists", () => {
        expect.assertions(3);

        const { logger, warns } = silentLogger();

        runLinkCommand({ cwd: workdir, logger, now: () => "2026-01-01T00:00:00.000Z", url: "https://x.workers.dev" });

        expect(existsSync(join(workdir, LINKED_PROJECT_FILE))).toBe(true);

        const removed = runLinkCommand({ cwd: workdir, logger, remove: true });

        expect(existsSync(join(workdir, LINKED_PROJECT_FILE))).toBe(false);

        const removedAgain = runLinkCommand({ cwd: workdir, logger, remove: true });

        expect(removed.code === 0 && removedAgain.code === 0 && warns.length > 0).toBe(true);
    });
});
