/* eslint-disable no-secrets/no-secrets, no-template-curly-in-string -- asserting CI secret-reference syntax is emitted verbatim */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isCiProvider, scaffoldCiWorkflow, WORKFLOWS, writeCiWorkflow } from "../../src/util/ci-workflow";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): { infos: string[]; logger: Logger } => {
    const infos: string[] = [];

    return { infos, logger: { error: () => {}, info: (m) => infos.push(m), success: (m) => infos.push(m), warn: (m) => infos.push(m) } };
};

describe("ci-workflow", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ci-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("isCiProvider accepts github/gitlab and rejects others", () => {
        expect.assertions(3);

        expect(isCiProvider("github")).toBe(true);
        expect(isCiProvider("gitlab")).toBe(true);
        expect(isCiProvider("circle")).toBe(false);
    });

    it("github writes .github/workflows/deploy.yml with the secret references", () => {
        expect.assertions(3);

        const result = writeCiWorkflow(workdir, "github");

        expect(result.written).toBe(true);

        const yaml = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");

        expect(yaml).toContain("${{ secrets.CLOUDFLARE_API_TOKEN }}");
        expect(yaml).toContain("lunora deploy");
    });

    it("gitlab writes .gitlab-ci.yml gated on the default branch", () => {
        expect.assertions(3);

        const result = writeCiWorkflow(workdir, "gitlab");

        expect(result.written).toBe(true);
        expect(WORKFLOWS.gitlab.file).toBe(".gitlab-ci.yml");

        const yaml = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(yaml).toContain("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    });

    it("both providers document the committed-lockfile prerequisite", () => {
        expect.assertions(2);

        writeCiWorkflow(workdir, "github");
        writeCiWorkflow(workdir, "gitlab");

        const github = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        const gitlab = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(github).toContain("commit your pnpm-lock.yaml");
        expect(gitlab).toContain("commit your pnpm-lock.yaml");
    });

    it("both providers include a preview job running `lunora deploy --preview`", () => {
        expect.assertions(4);

        writeCiWorkflow(workdir, "github");
        writeCiWorkflow(workdir, "gitlab");

        const github = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        const gitlab = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(github).toContain("pull_request");
        expect(github).toContain("lunora deploy --preview");
        expect(gitlab).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
        expect(gitlab).toContain("lunora deploy --preview");
    });

    it("skips an existing pipeline unless overwrite is set", () => {
        expect.assertions(2);

        const path = join(workdir, WORKFLOWS.github.file);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "name: Mine\n", "utf8");

        expect(writeCiWorkflow(workdir, "github").skipped).toBe(true);
        expect(writeCiWorkflow(workdir, "github", { overwrite: true }).written).toBe(true);
    });

    it("scaffoldCiWorkflow logs the provider-specific secrets hint", () => {
        expect.assertions(2);

        const { infos, logger } = silentLogger();

        scaffoldCiWorkflow(workdir, "gitlab", logger);

        const out = infos.join("\n");

        expect(out).toContain("CI/CD variables");
        expect(existsSync(join(workdir, ".gitlab-ci.yml"))).toBe(true);
    });
});
