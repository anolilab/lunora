import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeLinkedProject } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderDeploySummary } from "../../src/util/deploy-summary";
import type { Logger } from "../../src/util/logger";

const recordingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (message: string): void => {
        lines.push(message);
    };

    return { lines, logger: { error: push, info: push, success: push, warn: push } };
};

describe("renderDeploySummary", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-summary-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("shows the linked worker url, env, and next-step commands", () => {
        expect.assertions(5);

        writeLinkedProject(workdir, { workerName: "linked-name", workerUrl: "https://app.acme.workers.dev" });

        const { lines, logger } = recordingLogger();

        renderDeploySummary({ cwd: workdir, env: "production", logger });

        const out = lines.join("\n");

        expect(out).toContain("https://app.acme.workers.dev");
        expect(out).toContain("production");
        // No "migrations: applied": the line was rendered from the `--migrate`
        // flag rather than the outcome, so it claimed migrations had run when
        // discovery had thrown or the project declared none. The migration path
        // already logs each id it applies.
        expect(out).not.toContain("migrations:");
        expect(out).toContain("lunora view --remote");
        expect(out).toContain("lunora logs");
    });

    it("falls back to the wrangler name and a link hint when not linked", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), JSON.stringify({ name: "from-wrangler" }), "utf8");

        const { lines, logger } = recordingLogger();

        renderDeploySummary({ cwd: workdir, logger });

        const out = lines.join("\n");

        expect(out).toContain("from-wrangler");
        expect(out).toContain("lunora link --url");
    });
});
