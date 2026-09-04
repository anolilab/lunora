/**
 * Scaffold a CI deploy pipeline for a Lunora project — the `lunora init --ci`
 * convenience (Vercel's "git connect", minus the hosted bits). Supports GitHub
 * Actions and GitLab CI; each writes a pipeline that runs `lunora prepare` +
 * `lunora deploy` with the Cloudflare credentials wrangler reads from the
 * environment.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PackageManager } from "./detect-package-manager";
import { execArgsFor, installArgsFor } from "./detect-package-manager";
import type { Logger } from "./logger";

/** Supported CI providers. */
type CiProvider = "github" | "gitlab";

/**
 * Everything the GitHub/GitLab templates need per package manager. Derived
 * mostly from {@link execArgsFor} (so the exec convention lives in exactly one
 * place) plus the handful of facts that only make sense in a CI pipeline: the
 * committed lockfile's name, the frozen/CI install line, and how each manager
 * gets provisioned on a stock runner image.
 */
interface PmCiProfile {
    /**
     * `actions/setup-node`'s built-in `cache:` value for this manager, or
     * `undefined` when unsupported (bun) — the `cache:` line is omitted rather
     * than passed a value `setup-node` rejects.
     */
    githubCacheKey?: "npm" | "pnpm" | "yarn";
    /** Extra GitHub Actions step that provisions the manager itself, run before `actions/setup-node`. Empty for managers the runner (or `setup-node`) already provisions. */
    githubSetupStep: string;
    /** GitLab job `image:` — a manager without its own base image on `node:22` gets one that already has it. */
    gitlabImage: string;
    /** GitLab `before_script` line(s) that provision the manager, before the install line. */
    gitlabProvisionScript: ReadonlyArray<string>;
    /** The CI-appropriate ("frozen lockfile") install command. */
    installCmd: string;
    /** The committed lockfile this manager expects. */
    lockfile: string;
}

const PM_CI_PROFILES: Record<PackageManager, PmCiProfile> = {
    bun: {
        githubCacheKey: undefined,
        githubSetupStep: "      - uses: oven-sh/setup-bun@v2\n",
        gitlabImage: "oven/bun:1",
        gitlabProvisionScript: [],
        installCmd: "bun install --frozen-lockfile",
        lockfile: "bun.lockb",
    },
    npm: {
        githubCacheKey: "npm",
        githubSetupStep: "",
        gitlabImage: "node:22",
        gitlabProvisionScript: [],
        installCmd: "npm ci",
        lockfile: "package-lock.json",
    },
    pnpm: {
        githubCacheKey: "pnpm",
        // `version` is REQUIRED unless the project's package.json carries a
        // `packageManager` field, and no Lunora template writes one — so the
        // bare step failed every scaffolded pipeline at setup. `latest` rather
        // than a pinned major: this file ships inside the CLI, so a number here
        // goes stale in every project scaffolded after the next pnpm release,
        // which is the same class of defect. A project that pins
        // `packageManager` can drop this `with:` block and the action will
        // follow the pin.
        githubSetupStep: "      - uses: pnpm/action-setup@v4\n        with:\n          version: latest\n",
        gitlabImage: "node:22",
        gitlabProvisionScript: ["corepack enable"],
        installCmd: "pnpm install --frozen-lockfile",
        lockfile: "pnpm-lock.yaml",
    },
    yarn: {
        githubCacheKey: "yarn",
        githubSetupStep: "",
        gitlabImage: "node:22",
        gitlabProvisionScript: ["corepack enable"],
        installCmd: "yarn install --frozen-lockfile",
        lockfile: "yarn.lock",
    },
};

/**
 * The shell command that runs `lunora` (plus `args`) with `manager` — built
 * from {@link execArgsFor} rather than hand-duplicated, so the pnpm/npm/yarn/
 * bun exec convention can't drift between the CI templates and the rest of the
 * CLI.
 */
const execLine = (manager: PackageManager, args: ReadonlyArray<string>): string => {
    const resolved = execArgsFor(manager, "lunora", args);

    return [resolved.command, ...resolved.args].join(" ");
};

/**
 * The GitHub Actions steps shared by the `deploy` and `preview` jobs: checkout,
 * provision the manager, provision Node, install with a frozen lockfile.
 */
const githubSetupSteps = (pm: PmCiProfile): string =>
    `      - uses: actions/checkout@v4
${pm.githubSetupStep}      - uses: actions/setup-node@v4
        with:
          node-version: 22
${pm.githubCacheKey === undefined ? "" : `          cache: ${pm.githubCacheKey}\n`}      - run: ${pm.installCmd}`;

const buildGithubContent = (manager: PackageManager): string => {
    const pm = PM_CI_PROFILES[manager];
    const requirement =
        pm.githubCacheKey === undefined
            ? `# (below) requires it — run \`${manager} install\` locally and`
            : `# (below) and the ${manager} cache both require it — run \`${manager} install\` locally and`;

    // The `\${{ … }}` escapes keep GitHub's expression syntax literal inside this
    // template literal (so JS doesn't try to interpolate it). Block-scoped,
    // not `-next-line`: the manager interpolations above push the flagged
    // quasi past the line right after this comment.
    /* eslint-disable no-secrets/no-secrets -- GitHub Actions secret *reference*, not a secret value */
    return `name: Deploy

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

# Prerequisite: commit your ${pm.lockfile}. \`${pm.installCmd}\`
${requirement}
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
${githubSetupSteps(pm)}
      # Codegen + wrangler validation gate (no deploy) — fails fast on drift.
      - run: ${execLine(manager, ["prepare"])}
      - run: ${execLine(manager, ["deploy"])}

  # Preview version on every pull request — uploads a versioned preview URL;
  # production traffic is untouched.
  preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
${githubSetupSteps(pm)}
      - run: ${execLine(manager, ["deploy", "--preview"])}
`;
    /* eslint-enable no-secrets/no-secrets */
};

// GitLab injects masked CI/CD variables into the job environment, so wrangler
// picks up CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID automatically — no
// per-step reference needed. ($CI_* are GitLab predefined vars, not JS.)
const buildGitlabContent = (manager: PackageManager): string => {
    const pm = PM_CI_PROFILES[manager];
    const beforeScript = [...pm.gitlabProvisionScript, pm.installCmd].map((line) => `    - ${line}`).join("\n");

    return `stages:
  - deploy

# Prerequisite: commit your ${pm.lockfile}. \`${pm.installCmd}\`
# (below) requires it — run \`${manager} install\` locally and commit the lockfile
# before pushing, or the first pipeline fails.
#
# Set these as masked CI/CD variables (Settings → CI/CD → Variables):
#   CLOUDFLARE_API_TOKEN   — a Workers-scoped API token
#   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account id
.lunora_base:
  image: ${pm.gitlabImage}
  stage: deploy
  before_script:
${beforeScript}

# Production deploy on the default branch.
deploy:
  extends: .lunora_base
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    # Codegen + wrangler validation gate (no deploy) — fails fast on drift.
    - ${execLine(manager, ["prepare"])}
    - ${execLine(manager, ["deploy"])}

# Preview version on every merge request (versioned preview URL; production
# traffic is untouched).
preview:
  extends: .lunora_base
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - ${execLine(manager, ["deploy", "--preview"])}
`;
};

interface CiWorkflowSpec {
    /** Path (relative to the project root) of the pipeline file. */
    file: string;
    /** Where the provider stores the Cloudflare credentials — used in the hint. */
    secretsHint: string;
}

const WORKFLOWS: Record<CiProvider, CiWorkflowSpec> = {
    github: {
        file: join(".github", "workflows", "deploy.yml"),
        secretsHint: "repository secrets (Settings → Secrets and variables → Actions)",
    },
    gitlab: {
        file: ".gitlab-ci.yml",
        secretsHint: "masked CI/CD variables (Settings → CI/CD → Variables)",
    },
};

/** The pipeline content for `provider`, built for `manager`. */
const buildContent = (provider: CiProvider, manager: PackageManager): string =>
    provider === "github" ? buildGithubContent(manager) : buildGitlabContent(manager);

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
 * Write the provider's CI pipeline under `projectRoot`, targeting `manager`.
 * Refuses to clobber an existing pipeline unless `overwrite` is set (returns
 * `skipped`).
 */
const writeCiWorkflow = (projectRoot: string, provider: CiProvider, manager: PackageManager, options: WriteCiWorkflowOptions = {}): WriteCiWorkflowResult => {
    const path = join(projectRoot, WORKFLOWS[provider].file);

    if (existsSync(path) && options.overwrite !== true) {
        return { path, skipped: true, written: false };
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buildContent(provider, manager), "utf8");

    return { path, skipped: false, written: true };
};

/**
 * Scaffold the provider's CI pipeline for `manager` and log the outcome
 * (including where to put the Cloudflare credentials). Best-effort: never
 * throws, so it can't fail an otherwise-successful `lunora init`.
 */
const scaffoldCiWorkflow = (
    projectRoot: string,
    provider: CiProvider,
    manager: PackageManager,
    logger: Logger,
    options: WriteCiWorkflowOptions = {},
): WriteCiWorkflowResult => {
    const spec = WORKFLOWS[provider];

    try {
        const result = writeCiWorkflow(projectRoot, provider, manager, options);

        if (result.skipped) {
            logger.info(`--ci ${provider}: ${spec.file} already exists — left unchanged (re-run with overwrite to replace).`);
        } else {
            const install = installArgsFor(manager);
            const installHint = [install.command, ...install.args].join(" ");
            const { installCmd: frozenInstall, lockfile } = PM_CI_PROFILES[manager];

            logger.success(`--ci ${provider}: wrote ${spec.file}`);
            logger.info(`--ci ${provider}: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as ${spec.secretsHint} to enable deploys.`);
            logger.info(`--ci ${provider}: run \`${installHint}\` and commit ${lockfile} before pushing — the pipeline runs \`${frozenInstall}\`.`);
        }

        return result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`--ci ${provider}: could not write ${spec.file} (${message})`);

        return { path: join(projectRoot, spec.file), skipped: false, written: false };
    }
};

export type { CiProvider, PmCiProfile, WriteCiWorkflowOptions, WriteCiWorkflowResult };
export { buildContent, isCiProvider, PM_CI_PROFILES, scaffoldCiWorkflow, WORKFLOWS, writeCiWorkflow };
