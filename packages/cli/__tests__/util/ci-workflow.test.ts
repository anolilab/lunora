/* eslint-disable no-secrets/no-secrets, no-template-curly-in-string -- asserting CI secret-reference syntax is emitted verbatim */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildContent, isCiProvider, PM_CI_PROFILES, scaffoldCiWorkflow, WORKFLOWS, writeCiWorkflow } from "../../src/util/ci-workflow";
import type { PackageManager } from "../../src/util/detect-package-manager";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): { infos: string[]; logger: Logger } => {
    const infos: string[] = [];

    return { infos, logger: { error: () => {}, info: (m) => infos.push(m), success: (m) => infos.push(m), warn: (m) => infos.push(m) } };
};

/**
 * The full pnpm output, pinned line by line — originally to prove the
 * four-manager parameterization changed no bytes, and now as the readable
 * record of what a scaffolded pipeline actually runs. The one deliberate
 * departure from that first capture is `pnpm/action-setup`'s `version`, which
 * the action requires when the project declares no `packageManager`.
 */
const ORIGINAL_PNPM_GITHUB = `name: Deploy

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

# Prerequisite: commit your pnpm-lock.yaml. \`pnpm install --frozen-lockfile\`
# (below) and the pnpm cache both require it — run \`pnpm install\` locally and
# commit the lockfile before pushing, or the first CI run fails.
#
# Set these repository secrets (Settings → Secrets and variables → Actions):
#   CLOUDFLARE_API_TOKEN   — a Workers-scoped API token
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
env:
  CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

jobs:
  # Production deploy on push to the default branch.
  deploy:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Codegen + wrangler validation gate (no deploy) — fails fast on drift.
      - run: pnpm exec lunora prepare
      - run: pnpm exec lunora deploy

  # Preview version on every pull request — uploads a versioned preview URL;
  # production traffic is untouched.
  preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec lunora deploy --preview
`;

const ORIGINAL_PNPM_GITLAB = `stages:
  - deploy

# Prerequisite: commit your pnpm-lock.yaml. \`pnpm install --frozen-lockfile\`
# (below) requires it — run \`pnpm install\` locally and commit the lockfile
# before pushing, or the first pipeline fails.
#
# Set these as masked CI/CD variables (Settings → CI/CD → Variables):
#   CLOUDFLARE_API_TOKEN   — a Workers-scoped API token
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
.lunora_base:
  image: node:22
  stage: deploy
  before_script:
    - corepack enable
    - pnpm install --frozen-lockfile

# Production deploy on the default branch.
deploy:
  extends: .lunora_base
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    # Codegen + wrangler validation gate (no deploy) — fails fast on drift.
    - pnpm exec lunora prepare
    - pnpm exec lunora deploy

# Preview version on every merge request (versioned preview URL; production
# traffic is untouched).
preview:
  extends: .lunora_base
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - pnpm exec lunora deploy --preview
`;

const MANAGERS: ReadonlyArray<PackageManager> = ["npm", "pnpm", "yarn", "bun"];

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

    it("pins the whole pnpm output for both providers, line by line", () => {
        expect.assertions(2);

        expect(buildContent("github", "pnpm")).toBe(ORIGINAL_PNPM_GITHUB);
        expect(buildContent("gitlab", "pnpm")).toBe(ORIGINAL_PNPM_GITLAB);
    });

    it("gives pnpm/action-setup a version, which it requires without a packageManager field", () => {
        expect.assertions(2);

        // The action's `version` input is optional ONLY when the project's
        // package.json carries `packageManager`, and no Lunora template writes
        // one — so the bare step failed the very first CI run of every
        // scaffolded pnpm project, in its setup step.
        const github = buildContent("github", "pnpm");

        expect(github).toContain("      - uses: pnpm/action-setup@v4\n        with:\n          version: latest\n");
        // Both jobs (deploy + preview) get it, not just the first.
        expect(github.match(/pnpm\/action-setup@v4\n {8}with:\n {10}version: latest\n/gu) ?? []).toHaveLength(2);
    });

    it("github writes .github/workflows/deploy.yml with the secret references", () => {
        expect.assertions(3);

        const result = writeCiWorkflow(workdir, "github", "pnpm");

        expect(result.written).toBe(true);

        const yaml = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");

        expect(yaml).toContain("${{ secrets.CLOUDFLARE_API_TOKEN }}");
        expect(yaml).toContain("lunora deploy");
    });

    it("gitlab writes .gitlab-ci.yml gated on the default branch", () => {
        expect.assertions(3);

        const result = writeCiWorkflow(workdir, "gitlab", "pnpm");

        expect(result.written).toBe(true);
        expect(WORKFLOWS.gitlab.file).toBe(".gitlab-ci.yml");

        const yaml = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(yaml).toContain("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    });

    it("both providers document the committed-lockfile prerequisite", () => {
        expect.assertions(2);

        writeCiWorkflow(workdir, "github", "pnpm");
        writeCiWorkflow(workdir, "gitlab", "pnpm");

        const github = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        const gitlab = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(github).toContain("commit your pnpm-lock.yaml");
        expect(gitlab).toContain("commit your pnpm-lock.yaml");
    });

    it("both providers include a preview job running `lunora deploy --preview`", () => {
        expect.assertions(4);

        writeCiWorkflow(workdir, "github", "pnpm");
        writeCiWorkflow(workdir, "gitlab", "pnpm");

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

        expect(writeCiWorkflow(workdir, "github", "pnpm").skipped).toBe(true);
        expect(writeCiWorkflow(workdir, "github", "pnpm", { overwrite: true }).written).toBe(true);
    });

    it("scaffoldCiWorkflow logs the provider-specific secrets hint", () => {
        expect.assertions(2);

        const { infos, logger } = silentLogger();

        scaffoldCiWorkflow(workdir, "gitlab", "pnpm", logger);

        const out = infos.join("\n");

        expect(out).toContain("CI/CD variables");
        expect(existsSync(join(workdir, ".gitlab-ci.yml"))).toBe(true);
    });

    it("scaffoldCiWorkflow's closing hint names the detected manager, not a hardcoded pnpm", () => {
        expect.assertions(2);

        const { infos, logger } = silentLogger();

        scaffoldCiWorkflow(workdir, "github", "yarn", logger);

        const out = infos.join("\n");

        expect(out).toContain("run `yarn install`");
        expect(out).toContain("yarn install --frozen-lockfile");
    });

    describe.each(MANAGERS)("%s", (manager) => {
        it("produces a github pipeline with a setup, install, and exec step", () => {
            expect.assertions(4);

            const yaml = buildContent("github", manager);

            expect(yaml).toContain(PM_CI_PROFILES[manager].installCmd);
            expect(yaml).toContain(`commit your ${PM_CI_PROFILES[manager].lockfile}`);
            expect(yaml).toContain("lunora prepare");
            expect(yaml).toContain("lunora deploy");
        });

        it("produces a gitlab pipeline with a provision/install before_script and an exec script", () => {
            expect.assertions(3);

            const yaml = buildContent("gitlab", manager);

            expect(yaml).toContain(PM_CI_PROFILES[manager].installCmd);
            expect(yaml).toContain("lunora prepare");
            expect(yaml).toContain("lunora deploy --preview");
        });

        it("round-trips through writeCiWorkflow onto disk", () => {
            expect.assertions(1);

            const result = writeCiWorkflow(workdir, "github", manager);

            expect(result.written).toBe(true);
        });
    });

    it("bun's github pipeline omits the unsupported setup-node cache key rather than passing it an invalid value", () => {
        expect.assertions(2);

        const yaml = buildContent("github", "bun");

        expect(yaml).toContain("oven-sh/setup-bun");
        expect(yaml).not.toMatch(/cache: bun/u);
    });
});
