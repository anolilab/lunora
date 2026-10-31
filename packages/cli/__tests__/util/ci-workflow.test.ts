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
#   CLOUDFLARE_API_TOKEN   — the production deploy's token (Workers Scripts: Edit).
#                            Only the production deploy step receives it.
#   CLOUDFLARE_PREVIEW_API_TOKEN — a separate token for previews: Workers Scripts,
#                            D1, Workers KV Storage and Workers R2 Storage: Edit
#                            (previews make their own D1, KV and R2), limited to
#                            one account. Only the \`lunora preview\` steps receive
#                            it, never the install or checkout steps, which run
#                            a pull request's own dependency scripts.
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
#   LUNORA_DEPLOY_URL      — the production worker's URL (after the first deploy)
#   LUNORA_ADMIN_TOKEN     — the production worker's admin token
#   LUNORA_PREVIEW_SECRET_SEED — optional: any long random string; previews then
#                            keep their minted secrets across pushes. The preview
#                            job builds this repository's own pull requests with
#                            CLOUDFLARE_PREVIEW_API_TOKEN in its environment, and
#                            that token can redeploy any preview with any secrets,
#                            so the seed adds no access. Never run previews for
#                            untrusted pull requests; forks get no secrets here.
#
# Previews are recorded under "lunora.appId" in package.json, which the first
# local \`lunora preview deploy\` writes. Commit it: the jobs below find a
# project's previews by it, so it survives a rename of the Worker.
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
      # Unset (a first deploy), the gate blocks as before. A *.workers.dev URL is
      # only trusted when the project is linked and .lunora/ is not committed, so
      # CI has no link: there the gate stays blocked, and a tightening needs a
      # migration or --allow-schema-drift. A custom domain on a declared route works.
      - run: pnpm exec lunora deploy --migrate-url "\${{ secrets.LUNORA_DEPLOY_URL }}"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
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
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_PREVIEW_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
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
      # Deleting needs none of the project's dependency scripts, and one that fails must not keep a closed preview alive.
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
      - run: pnpm install --frozen-lockfile --ignore-scripts
      # The pull request may have changed lunora.appId or the Worker name, so its previews are recorded under an identity
      # this base checkout does not have. Its package.json and wrangler config are copied out with git and read by the CLI
      # as data: nothing from the head is installed, built or run. The values never pass through a shell or a \${{ }} in a script.
      - name: Copy the pull request head's project files
        env:
          PR_NUMBER: \${{ github.event.pull_request.number }}
          HEAD_DIR: \${{ runner.temp }}/lunora-head
        run: |
          mkdir -p "$HEAD_DIR"
          if git fetch --depth=1 origin "refs/pull/$PR_NUMBER/head"; then
            for file in package.json wrangler.jsonc wrangler.json; do
              git show "FETCH_HEAD:$file" > "$HEAD_DIR/$file" 2>/dev/null || rm -f "$HEAD_DIR/$file"
            done
          else
            echo "could not fetch the pull request head; the preview is looked up under the base branch's identity only"
          fi
      # Exit 5 is "no record": the pull request never got a preview (refused, or opened before this workflow). The CLI
      # answers it only when the head's identity is the base's, or could not be read; two different identities with no
      # record under either fail the job.
      - run: pnpm exec lunora preview delete \${{ github.event.pull_request.number }} --head-dir "$HEAD_DIR" || [ "$?" -eq 5 ]
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_PREVIEW_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          HEAD_DIR: \${{ runner.temp }}/lunora-head

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
# Set these as CI/CD variables (Settings → CI/CD → Variables), each Masked AND
# Protected, with Environment scope "production":
#   CLOUDFLARE_API_TOKEN   — a Workers-scoped API token
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
#   LUNORA_DEPLOY_URL      — the production worker's URL (after the first deploy)
#   LUNORA_ADMIN_TOKEN     — the production worker's admin token
# Protected variables reach only pipelines on protected branches and tags, so a
# merge-request pipeline from a feature branch, which runs the project's own
# code, gets none of them. Keep your default branch protected (it is by default).
# The "production" scope reaches only jobs that declare environment: production,
# which is the deploy job alone; the check job below uses none of these.
#
# Previews run in merge-request pipelines, so they need credentials of their own.
# Set these two again, Masked but NOT Protected, with Environment scope "preview/*"
# (only jobs that declare a preview/* environment get them):
#   CLOUDFLARE_API_TOKEN   — a separate token: Workers Scripts, D1, Workers KV
#                            Storage and Workers R2 Storage: Edit (previews make
#                            their own D1, KV and R2). Never the production token.
#                            Create it in Cloudflare (My Profile > API Tokens >
#                            Create Custom Token) with only those four Account
#                            permissions, "Account Resources" limited to this one
#                            account (and no Zone, User or other permission).
#                            Residual risk: the variable is not Protected, so
#                            anyone who can push a branch here can read it and
#                            can then edit or delete every Worker, D1 database,
#                            KV namespace and R2 bucket on that account, not just
#                            previews: the token cannot be narrowed to the
#                            preview-named resources. Use a dedicated account for
#                            previews if production shares this one.
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
#   LUNORA_PREVIEW_SECRET_SEED — optional: any long random string; previews then
#                            keep their minted secrets across pushes. The preview
#                            jobs run only for merge requests from this project
#                            (never forks) and already hold the preview token, which
#                            can redeploy any preview with any secrets, so the seed
#                            adds no access. Anyone who can push a branch here can
#                            run code with it: never run previews for untrusted
#                            merge requests.
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
  environment:
    name: production
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    # When a schema change tightens a table, the drift gate reads that table's
    # stored rows from this worker and lets the change ship if every row fits.
    # Unset (a first deploy), the gate blocks as before. A *.workers.dev URL is
    # only trusted when the project is linked and .lunora/ is not committed, so
    # CI has no link: there the gate stays blocked, and a tightening needs a
    # migration or --allow-schema-drift. A custom domain on a declared route works.
    - pnpm exec lunora deploy --migrate-url "$LUNORA_DEPLOY_URL"

# Every merge request from this project gets an isolated preview: its own
# Worker, Durable Objects, D1, KV and R2, never production's. GitLab runs the
# stop job below when the environment stops: its source branch is deleted (merge
# with "delete source branch"), someone stops it under Operate > Environments,
# or it auto-stops. A closed merge request that keeps its branch is cleaned up
# by the auto-stop, or by stopping the environment by hand.
#
# The install runs the merge request's own dependency scripts, so it is a job of
# its own with no environment: the preview/* variables are scoped to jobs that
# declare one, so this job never receives the preview token. The preview job
# reuses its node_modules and holds the token only for the preview command.
preview_install:
  extends: .lunora_base
  stage: .pre
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
  script:
    - echo "dependencies installed without credentials"
  artifacts:
    paths:
      - node_modules/
    expire_in: 1 hour

preview:
  extends: .lunora_base
  needs:
    - preview_install
  before_script:
    - corepack enable
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
  resource_group: lunora-preview-$CI_MERGE_REQUEST_IID
  environment:
    name: preview/$CI_MERGE_REQUEST_IID
    on_stop: preview_delete
    auto_stop_in: 2 weeks
  script:
    - pnpm exec lunora preview deploy "$CI_MERGE_REQUEST_IID"

# Deletes the preview Worker and every resource recorded for it. It installs in the
# job that holds the preview token, so dependency scripts are switched off: deleting
# needs none of them.
preview_delete:
  extends: .lunora_base
  before_script:
    - corepack enable
    - pnpm install --frozen-lockfile --ignore-scripts
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

    it("gitlab keeps production secrets out of merge-request pipelines: protected, production-scoped, deploy job only", () => {
        expect.assertions(12);

        writeCiWorkflow(workdir, "gitlab", "pnpm");

        const yaml = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");
        const deploy = yaml.slice(yaml.indexOf("\ndeploy:"), yaml.indexOf("\n# Every merge request"));
        const check = yaml.slice(yaml.indexOf("\ncheck:"));

        expect(yaml).toContain("Masked AND");
        expect(yaml).toContain("Protected");
        expect(yaml).toContain('Environment scope "production"');
        expect(deploy).toContain("environment:\n    name: production");
        expect(deploy).toContain("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
        expect(check).not.toContain("environment:");
        // Previews run in merge-request pipelines, so they take separate credentials scoped to the preview environments.
        expect(yaml).toContain('Environment scope "preview/*"');
        expect(yaml).toContain("name: preview/$CI_MERGE_REQUEST_IID");
        expect(deploy).not.toContain("preview");

        for (const name of ["LUNORA_ADMIN_TOKEN", "LUNORA_DEPLOY_URL", "CLOUDFLARE_API_TOKEN"]) {
            expect(check).not.toContain(name);
        }
    });

    it("both providers deploy an isolated preview per pull/merge request and delete it when it closes, never a version upload", () => {
        expect.assertions(18);

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
        expect(teardown).toContain('lunora preview delete ${{ github.event.pull_request.number }} --head-dir "$HEAD_DIR" || [ "$?" -eq 5 ]');
        // The head's identity is copied out with git and read as data: no step of this job installs or runs head code, and
        // no head-controlled value is interpolated into a script.
        expect(teardown).toContain('git show "FETCH_HEAD:$file"');
        expect(teardown).toContain("HEAD_DIR: ${{ runner.temp }}/lunora-head");
        expect(teardown).toContain("--ignore-scripts");
        expect(teardown.match(/run: [^\n]*\$\{\{ github\.(?!event\.pull_request\.number)/gu) ?? []).toStrictEqual([]);
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
        expect(gitlab.split(same)).toHaveLength(4);
        expect(gitlab.split(other)).toHaveLength(2);
        expect([...gitlab.matchAll(/\$CI_[A-Z_]+/gu)].every((match) => KNOWN_GITLAB_VARIABLES.has(match[0]))).toBe(true);
        expect(gitlab).not.toContain("_APP_ID");
    });

    it("github hands the Cloudflare tokens only to the step that needs them, never to install or checkout, and never the production token to a preview", () => {
        expect.assertions(8);

        writeCiWorkflow(workdir, "github", "pnpm");

        const yaml = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        // Steps start at six spaces; split into one block per step.
        const steps = yaml.split("\n      - ").slice(1);
        const holding = (secret: string): string[] => steps.filter((step) => step.includes(`secrets.${secret}`));

        // Nothing at the workflow level reaches every step, the dependency installs of a pull request included.
        expect(yaml.split("\njobs:")[0]).not.toContain("secrets.CLOUDFLARE");
        expect(holding("CLOUDFLARE_PREVIEW_API_TOKEN")).toHaveLength(2);

        for (const step of holding("CLOUDFLARE_PREVIEW_API_TOKEN")) {
            expect(step.startsWith("run: pnpm exec lunora preview")).toBe(true);
        }

        // The production token is for the production deploy step alone.
        expect(holding("CLOUDFLARE_API_TOKEN")).toHaveLength(1);
        expect(holding("CLOUDFLARE_API_TOKEN")[0]).toContain("lunora deploy --migrate-url");
        expect(steps.filter((step) => step.startsWith("run: pnpm install")).some((step) => step.includes("secrets."))).toBe(false);
        expect(steps.filter((step) => step.startsWith("uses: actions/checkout")).some((step) => step.includes("secrets."))).toBe(false);
    });

    it("gitlab installs a merge request's dependencies in a job with no environment, and deletes without dependency scripts", () => {
        expect.assertions(6);

        writeCiWorkflow(workdir, "gitlab", "pnpm");

        const yaml = readFileSync(join(workdir, ".gitlab-ci.yml"), "utf8");
        const job = (name: string): string => {
            const start = yaml.indexOf(`\n${name}:`);

            return yaml.slice(start, yaml.indexOf("\n\n", start));
        };

        // The preview/* variables are scoped to jobs that declare a preview environment: the install job declares none.
        expect(job("preview_install")).not.toContain("environment:");
        expect(job("preview_install")).toContain("node_modules/");
        expect(job("preview")).toContain("needs:\n    - preview_install");
        // The preview job does not install again: it would run the dependency scripts with the token.
        expect(job("preview")).not.toContain("pnpm install");
        expect(job("preview")).toContain("environment:\n    name: preview/$CI_MERGE_REQUEST_IID");
        expect(job("preview_delete")).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    });

    it("github deletes a closed preview with the install's dependency scripts off, so a failing one cannot keep it alive", () => {
        expect.assertions(2);

        writeCiWorkflow(workdir, "github", "pnpm");

        const yaml = readFileSync(join(workdir, WORKFLOWS.github.file), "utf8");
        const teardown = yaml.slice(yaml.indexOf("  preview-delete:"), yaml.indexOf("  check:"));

        expect(teardown).toContain("pnpm install --frozen-lockfile --ignore-scripts");
        // The deploy jobs keep the ordinary install.
        expect(yaml.slice(yaml.indexOf("  deploy:"), yaml.indexOf("  preview:"))).not.toContain("--ignore-scripts");
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
