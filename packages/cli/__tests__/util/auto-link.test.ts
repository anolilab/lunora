import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LINKED_PROJECT_FILE, writeLinkedProject } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoLinkFromDeployOutput, parseDeployedUrl } from "../../src/util/auto-link";
import type { Logger } from "../../src/util/logger";

const recordingLogger = (): { logger: Logger; successes: string[]; warns: string[] } => {
    const successes: string[] = [];
    const warns: string[] = [];

    return {
        logger: { error: () => {}, info: () => {}, success: (message) => successes.push(message), warn: (message) => warns.push(message) },
        successes,
        warns,
    };
};

describe("parseDeployedUrl", () => {
    it("prefers a *.workers.dev origin", () => {
        expect.assertions(1);

        const output = "Total Upload: 1 KiB\nDeployed my-worker triggers\n  https://my-worker.acme.workers.dev\n";

        expect(parseDeployedUrl(output)).toBe("https://my-worker.acme.workers.dev");
    });

    it("falls back to any https URL", () => {
        expect.assertions(1);

        expect(parseDeployedUrl("Deployed to https://app.example.com (custom domain)")).toBe("https://app.example.com");
    });

    it("returns undefined when no URL is present", () => {
        expect.assertions(1);

        expect(parseDeployedUrl("Total Upload: 1 KiB\nNo URL here")).toBeUndefined();
    });

    it("returns undefined when stdout was not captured at all", () => {
        expect.assertions(1);

        expect(parseDeployedUrl(undefined)).toBeUndefined();
    });
});

describe("autoLinkFromDeployOutput", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-autolink-"));
        writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ name: "my-worker" }), "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("writes the link when the checkout has none", () => {
        expect.assertions(2);

        autoLinkFromDeployOutput({
            cwd: workdir,
            env: "production",
            logger: recordingLogger().logger,
            now: () => "2026-01-01T00:00:00.000Z",
            url: "https://my-worker.acme.workers.dev",
        });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://my-worker.acme.workers.dev");
        expect(written.workerName).toBe("my-worker");
    });

    it("does nothing when the deploy output carried no URL", () => {
        expect.assertions(1);

        autoLinkFromDeployOutput({ cwd: workdir, logger: recordingLogger().logger, url: undefined });

        expect(existsSync(join(workdir, LINKED_PROJECT_FILE))).toBe(false);
    });

    it("is a silent no-op when the recorded link already matches", () => {
        expect.assertions(3);

        writeLinkedProject(workdir, { env: "production", linkedAt: "2020-01-01T00:00:00.000Z", workerUrl: "https://auto.acme.workers.dev" });

        const recorded = recordingLogger();

        autoLinkFromDeployOutput({ cwd: workdir, env: "production", logger: recorded.logger, url: "https://auto.acme.workers.dev" });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        // Untouched — same stamp, no re-write.
        expect(written.linkedAt).toBe("2020-01-01T00:00:00.000Z");
        expect(recorded.warns).toEqual([]);
        expect(recorded.successes).toEqual([]);
    });

    it("warns and keeps the recorded value when the deployed URL differs", () => {
        expect.assertions(4);

        // The stale-link failure this exists to surface: `run` / `logs` /
        // `--migrate` would otherwise keep targeting a URL this deploy no longer
        // publishes to — but rewriting an explicit `lunora link` is equally wrong.
        writeLinkedProject(workdir, { workerUrl: "https://manual.workers.dev" });

        const recorded = recordingLogger();

        autoLinkFromDeployOutput({ cwd: workdir, logger: recorded.logger, url: "https://auto.acme.workers.dev" });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://manual.workers.dev");
        expect(recorded.warns).toHaveLength(1);
        // Names both URLs and the one command that resolves the disagreement.
        expect(recorded.warns[0]).toContain("https://manual.workers.dev");
        expect(recorded.warns[0]).toContain("lunora link --url https://auto.acme.workers.dev");
    });

    it("treats a link recorded for another --env as a mismatch, not a target to clobber", () => {
        expect.assertions(2);

        writeLinkedProject(workdir, { env: "production", workerUrl: "https://prod.acme.workers.dev" });

        const recorded = recordingLogger();

        autoLinkFromDeployOutput({ cwd: workdir, env: "staging", logger: recorded.logger, url: "https://staging.acme.workers.dev" });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://prod.acme.workers.dev");
        expect(recorded.warns).toHaveLength(1);
    });
});
