import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LINKED_PROJECT_FILE, writeLinkedProject } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoLinkFromDeployOutput, parseDeployedUrl } from "../../src/util/auto-link";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
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

    it("writes the link from captured deploy output", () => {
        expect.assertions(2);

        autoLinkFromDeployOutput({
            cwd: workdir,
            env: "production",
            logger: silentLogger(),
            now: () => "2026-01-01T00:00:00.000Z",
            output: "  https://my-worker.acme.workers.dev\n",
        });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://my-worker.acme.workers.dev");
        expect(written.workerName).toBe("my-worker");
    });

    it("does nothing when output was not captured", () => {
        expect.assertions(1);

        autoLinkFromDeployOutput({ cwd: workdir, logger: silentLogger(), output: undefined });

        expect(existsSync(join(workdir, LINKED_PROJECT_FILE))).toBe(false);
    });

    it("never overwrites an existing link", () => {
        expect.assertions(1);

        writeLinkedProject(workdir, { workerUrl: "https://manual.workers.dev" });

        autoLinkFromDeployOutput({ cwd: workdir, logger: silentLogger(), output: "https://auto.acme.workers.dev" });

        const written = JSON.parse(readFileSync(join(workdir, LINKED_PROJECT_FILE), "utf8"));

        expect(written.workerUrl).toBe("https://manual.workers.dev");
    });
});
