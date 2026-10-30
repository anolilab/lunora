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
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:

# Prerequisite: commit your pnpm-lock.yaml. \`pnpm install --frozen-lockfile\`
# (below) and the pnpm cache both require it — run \`pnpm install\` locally and
# commit the lockfile before pushing, or the first CI run fails.
#
# Set these repository secrets (Settings → Secrets and variables → Actions):
#   CLOUDFLARE_API_TOKEN   — an API token with Workers Scripts, D1, Workers KV
#                            Storage and Workers R2 Storage: Edit (previews make
#                            their own D1, KV and R2)
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
#   LUNORA_DEPLOY_URL      — the production worker's URL (after the first deploy)
#   LUNORA_ADMIN_TOKEN     — the production worker's admin token
#   LUNORA_PREVIEW_SECRET_SEED — optional: any long random string; previews then
#                            keep their minted secrets across pushes. The preview
#                            job builds this repository's own pull requests with
#                            CLOUDFLARE_API_TOKEN already in its environment, and
#                            that token can redeploy any preview with any secrets,
#                            so the seed adds no access. Never run previews for
#                            untrusted pull requests; forks get no secrets here.
#
# Previews are recorded under "lunora.appId" in package.json, which the first
# local \`lunora preview deploy\` writes. Commit it: the jobs below find a
# project's previews by it, so it survives a rename of the Worker.
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
      # When a schema change tightens a table, the drift gate reads that table's
      # stored rows from this worker and lets the change ship if every row fits.
      # Unset (a first deploy), the gate blocks as before.
      - run: pnpm exec lunora deploy --migrate-url "\${{ secrets.LUNORA_DEPLOY_URL }}"
        env:
          LUNORA_ADMIN_TOKEN: \${{ secrets.LUNORA_ADMIN_TOKEN }}

  # Every pull request from this repository gets an isolated preview: its own
  # Worker, Durable Objects, D1, KV and R2, never production's. One run per
  # pull request at a time, so a teardown never races a deploy.
  preview:
    if: github.event_name == 'pull_request' && github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'
    runs-on: ubuntu-latest
    concurrency: lunora-preview-\${{ github.event.pull_request.number }}
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
      - run: pnpm exec lunora preview deploy \${{ github.event.pull_request.number }}
        env:
          LUNORA_PREVIEW_SECRET_SEED: \${{ secrets.LUNORA_PREVIEW_SECRET_SEED }}

  # Closing or merging the pull request deletes the preview Worker and every
  # resource recorded for it.
  preview-delete:
    if: github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]'
    runs-on: ubuntu-latest
    concurrency: lunora-preview-\${{ github.event.pull_request.number }}
    permissions:
      contents: read
    steps:
      # A closed, unmerged pull request may have no merge ref left to check out;
      # the base branch names the same production Worker the record is keyed by.
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.base.ref }}
      - uses: pnpm/action-setup@v4
        with:
          version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Exit 5 is "no record": the pull request never got a preview (refused, or opened before this workflow).
      - run: pnpm exec lunora preview delete \${{ github.event.pull_request.number }} || [ "$?" -eq 5 ]

  # A fork's or Dependabot's pull request gets no secrets, so it runs the
  # deploy pipeline, bundle included, and publishes nothing.
  check:
    if: github.event_name == 'pull_request' && github.event.action != 'closed' && (github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.login == 'dependabot[bot]')
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
      - run: pnpm exec lunora deploy --dry-run
`;

const ORIGINAL_PNPM_GITLAB = `stages:
  - deploy

# Prerequisite: commit your pnpm-lock.yaml. \`pnpm install --frozen-lockfile\`
# (below) requires it — run \`pnpm install\` locally and commit the lockfile
# before pushing, or the first pipeline fails.
#
# Set these as masked CI/CD variables (Settings → CI/CD → Variables):
#   CLOUDFLARE_API_TOKEN   — an API token with Workers Scripts, D1, Workers KV
#                            Storage and Workers R2 Storage: Edit (previews make
#                            their own D1, KV and R2)
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
#   LUNORA_DEPLOY_URL      — the production worker's URL (after the first deploy)
#   LUNORA_ADMIN_TOKEN     — the production worker's admin token
#   LUNORA_PREVIEW_SECRET_SEED — optional: any long random string; previews then
#                            keep their minted secrets across pushes. The preview
#                            job builds this repository's own pull requests with
#                            CLOUDFLARE_API_TOKEN already in its environment, and
#                            that token can redeploy any preview with any secrets,
#                            so the seed adds no access. Never run previews for
#                            untrusted pull requests; forks get no secrets here.
#
# Previews are recorded under "lunora.appId" in package.json, which the first
# local \`lunora preview deploy\` writes. Commit it: the jobs below find a
# project's previews by it, so it survives a rename of the Worker.
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
    # When a schema change tightens a table, the drift gate reads that table's
    # stored rows from this worker and lets the change ship if every row fits.
    # Unset (a first deploy), the gate blocks as before.
    - pnpm exec lunora deploy --migrate-url "$LUNORA_DEPLOY_URL"

# Every merge request from this project gets an isolated preview: its own
# Worker, Durable Objects, D1, KV and R2, never production's. GitLab runs the
# stop job below when the environment stops: its source branch is deleted (merge
# with "delete source branch"), someone stops it under Operate > Environments,
# or it auto-stops. A closed merge request that keeps its branch is cleaned up
# by the auto-stop, or by stopping the environment by hand.
preview:
  extends: .lunora_base
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
  resource_group: lunora-preview-$CI_MERGE_REQUEST_IID
  environment:
    name: preview/$CI_MERGE_REQUEST_IID
    on_stop: preview_delete
    auto_stop_in: 2 weeks
  script:
    - pnpm exec lunora preview deploy "$CI_MERGE_REQUEST_IID"

# Deletes the preview Worker and every resource recorded for it.
preview_delete:
  extends: .lunora_base
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
      when: manual
  allow_failure: true
  resource_group: lunora-preview-$CI_MERGE_REQUEST_IID
  environment:
    name: preview/$CI_MERGE_REQUEST_IID
    action: stop
  script:
    - pnpm exec lunora preview delete "$CI_MERGE_REQUEST_IID"

# A fork's merge request runs without this project's CI/CD variables, so it
# runs the deploy pipeline, bundle included, and publishes nothing.
check:
  extends: .lunora_base
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_PROJECT_ID
  script:
    - pnpm exec lunora deploy --dry-run
`;

const MANAGERS: ReadonlyArray<PackageManager> = ["npm", "pnpm", "yarn", "bun"];

/** The GitLab predefined variables the generated pipeline may reference. */
const KNOWN_GITLAB_VARIABLES: ReadonlySet<string> = new Set([
    "$CI_COMMIT_BRANCH",
    "$CI_DEFAULT_BRANCH",
    "$CI_MERGE_REQUEST_IID",
    "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID",
    "$CI_PIPELINE_SOURCE",
    "$CI_PROJECT_ID",
]);

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
        // Every job (deploy, preview, preview-delete, check) gets it, not just the first.
        expect(github.match(/pnpm\/action-setup@v4\n {8}with:\n {10}version: latest\n/gu) ?? []).toHaveLength(4);
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

    it("both providers deploy an isolated preview per pull/merge request and delete it when it closes, never a version upload", () => {
        expect.assertions(14);

        writeCiWorkflow(workdir, "github", "pnpm");
        writeCiWorkflow(workdir, "gitlab", "pnpm");

        const github = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        const gitlab = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");

        expect(github).toContain("types: [opened, synchronize, reopened, closed]");
        expect(github).toContain("lunora preview deploy ${{ github.event.pull_request.number }}");

        // The teardown runs only once the pull request closed.
        const teardown = github.slice(github.indexOf("  preview-delete:"), github.indexOf("  check:"));

        expect(teardown).toContain("github.event.action == 'closed'");
        expect(teardown).toContain("lunora preview delete ${{ github.event.pull_request.number }}");
        // A pull request that never got a preview (refused, or opened before the workflow) has no record: not a failed cleanup.
        expect(teardown).toContain('lunora preview delete ${{ github.event.pull_request.number }} || [ "$?" -eq 5 ]');
        expect(github).not.toContain("--preview");
        expect(gitlab).toContain('lunora preview deploy "$CI_MERGE_REQUEST_IID"');
        expect(gitlab).toContain("on_stop: preview_delete");
        expect(gitlab).toMatch(/action: stop\n {2}script:\n {4}- pnpm exec lunora preview delete "\$CI_MERGE_REQUEST_IID"/u);
        expect(gitlab).not.toContain("--preview");
        // A closed, unmerged pull request's merge ref can be gone; the teardown checks out the base branch.
        expect(teardown).toContain("ref: ${{ github.event.pull_request.base.ref }}");
        // Dependabot's pull requests get no Actions secrets either: the dry-run check, not a preview.
        expect(github.slice(github.indexOf("  check:"))).toContain("|| github.event.pull_request.user.login == 'dependabot[bot]')");
        // A fork's merge request has no CI/CD variables: it gets the dry-run check, not a preview.
        expect(gitlab).toContain('"merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID\n  resource_group');
        expect(gitlab.slice(gitlab.indexOf("\ncheck:"))).toContain(
            "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_PROJECT_ID\n  script:\n    - pnpm exec lunora deploy --dry-run",
        );
    });

    it("gates the GitLab secret-holding jobs on GitLab's own predefined variables, which a rename must not touch", () => {
        expect.assertions(4);

        writeCiWorkflow(workdir, "gitlab", "pnpm");

        const gitlab = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");
        const same = '- if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID';
        const other = '- if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_PROJECT_ID';

        // Undefined variables are both empty, so `==` holds for every merge request, fork code included.
        expect(gitlab.split(same)).toHaveLength(3);
        expect(gitlab.split(other)).toHaveLength(2);
        expect([...gitlab.matchAll(/\$CI_[A-Z_]+/gu)].every((match) => KNOWN_GITLAB_VARIABLES.has(match[0]))).toBe(true);
        expect(gitlab).not.toContain("_APP_ID");
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
            expect(yaml).toContain("lunora deploy --migrate-url");
            expect(yaml).toContain("LUNORA_ADMIN_TOKEN: ${{ secrets.LUNORA_ADMIN_TOKEN }}");
        });

        it("produces a gitlab pipeline with a provision/install before_script and an exec script", () => {
            expect.assertions(3);

            const yaml = buildContent("gitlab", manager);

            expect(yaml).toContain(PM_CI_PROFILES[manager].installCmd);
            expect(yaml).toContain('lunora deploy --migrate-url "$LUNORA_DEPLOY_URL"');
            expect(yaml).toContain('lunora preview delete "$CI_MERGE_REQUEST_IID"');
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
