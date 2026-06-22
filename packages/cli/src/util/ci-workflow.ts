/**
 * Scaffold a CI deploy pipeline for a Lunora project — the `lunora init --ci`
 * convenience (Vercel's "git connect", minus the hosted bits). Supports GitHub
 * Actions and GitLab CI; each writes a pipeline that runs `lunora prepare` +
 * `lunora deploy` with the Cloudflare credentials wrangler reads from the
 * environment.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "./logger";

/** Supported CI providers. */
type CiProvider = "github" | "gitlab";

// The `\${{ … }}` escapes keep GitHub's expression syntax literal inside this
// template literal (so JS doesn't try to interpolate it).
// eslint-disable-next-line no-secrets/no-secrets -- GitHub Actions secret *reference*, not a secret value
const GITHUB_CONTENT = `name: Deploy

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
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec lunora deploy --preview
`;

// GitLab injects masked CI/CD variables into the job environment, so wrangler
// picks up CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID automatically — no
// per-step reference needed. ($CI_* are GitLab predefined vars, not JS.)
const GITLAB_CONTENT = `stages:
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

interface CiWorkflowSpec {
    content: string;
    /** Path (relative to the project root) of the pipeline file. */
    file: string;
    /** Where the provider stores the Cloudflare credentials — used in the hint. */
    secretsHint: string;
}

const WORKFLOWS: Record<CiProvider, CiWorkflowSpec> = {
    github: {
        content: GITHUB_CONTENT,
        file: join(".github", "workflows", "deploy.yml"),
        secretsHint: "repository secrets (Settings → Secrets and variables → Actions)",
    },
    gitlab: {
        content: GITLAB_CONTENT,
        file: ".gitlab-ci.yml",
        secretsHint: "masked CI/CD variables (Settings → CI/CD → Variables)",
    },
};

/** Narrow a raw `--ci` value to a known {@link CiProvider}. */
const isCiProvider = (value: unknown): value is CiProvider => value === "github" || value === "gitlab";

interface WriteCiWorkflowResult {
    /** Absolute path of the pipeline file. */
    path: string;
    /** True when an existing pipeline was left untouched. */
    skipped: boolean;
    /** True when the file was written. */
    written: boolean;
}

interface WriteCiWorkflowOptions {
    /** Overwrite an existing pipeline instead of skipping it. */
    overwrite?: boolean;
}

/**
 * Write the provider's CI pipeline under `projectRoot`. Refuses to clobber an
 * existing pipeline unless `overwrite` is set (returns `skipped`).
 */
const writeCiWorkflow = (projectRoot: string, provider: CiProvider, options: WriteCiWorkflowOptions = {}): WriteCiWorkflowResult => {
    const spec = WORKFLOWS[provider];
    const path = join(projectRoot, spec.file);

    if (existsSync(path) && options.overwrite !== true) {
        return { path, skipped: true, written: false };
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, spec.content, "utf8");

    return { path, skipped: false, written: true };
};

/**
 * Scaffold the provider's CI pipeline and log the outcome (including where to
 * put the Cloudflare credentials). Best-effort: never throws, so it can't fail
 * an otherwise-successful `lunora init`.
 */
const scaffoldCiWorkflow = (projectRoot: string, provider: CiProvider, logger: Logger, options: WriteCiWorkflowOptions = {}): WriteCiWorkflowResult => {
    const spec = WORKFLOWS[provider];

    try {
        const result = writeCiWorkflow(projectRoot, provider, options);

        if (result.skipped) {
            logger.info(`--ci ${provider}: ${spec.file} already exists — left unchanged (re-run with overwrite to replace).`);
        } else {
            logger.success(`--ci ${provider}: wrote ${spec.file}`);
            logger.info(`--ci ${provider}: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as ${spec.secretsHint} to enable deploys.`);
            logger.info(
                `--ci ${provider}: run \`pnpm install\` and commit pnpm-lock.yaml before pushing — the pipeline runs \`pnpm install --frozen-lockfile\`.`,
            );
        }

        return result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`--ci ${provider}: could not write ${spec.file} (${message})`);

        return { path: join(projectRoot, spec.file), skipped: false, written: false };
    }
};

export type { CiProvider, WriteCiWorkflowOptions, WriteCiWorkflowResult };
export { isCiProvider, scaffoldCiWorkflow, WORKFLOWS, writeCiWorkflow };
