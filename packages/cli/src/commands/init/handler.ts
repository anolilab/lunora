import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { applyLintIgnores, BADGES, detectLintTools, isInteractive } from "@lunora/config";
import { walkSync } from "@visulima/fs";
import { basename, dirname, join, relative, resolve } from "@visulima/path";
import { downloadTemplate } from "giget";
import { applyEdits, modify } from "jsonc-parser";

import type { CiProvider } from "../../util/ci-workflow";
import { isCiProvider, scaffoldCiWorkflow } from "../../util/ci-workflow";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DetectedFramework, FrameworkDetection } from "../../util/detect-framework";
import { detectFramework } from "../../util/detect-framework";
import type { PackageManager, PackageManagerProbe } from "../../util/detect-package-manager";
import { addArgsFor, detectInstalledManagers, detectPackageManager, installArgsFor, runScriptCommand } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { patchViteConfig } from "../../util/patch-vite-config";
import { PromptCancelledError } from "../../util/prompt-cancelled";
import { resolveDistTag, resolvePinnedRepoRef, resolvePinnedSourceRef, resolveSourceRef, resolveTagVersions } from "../../util/source-ref";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { NextStep } from "../../util/tui-prompts";
import {
    tuiConfirm,
    tuiHeadline,
    tuiInfo,
    tuiMoonrise,
    tuiMultiSelect,
    tuiNextSteps,
    tuiSelect,
    tuiTasks,
    tuiText,
    withTuiBadgeProgress,
    withTuiSpinner,
} from "../../util/tui-prompts";
import type { FeatureItem } from "../add/features";
import { detectAuthUiItem } from "../add/features";
import { runAddCommand } from "../registry";
import describeDownloadFailure from "./download-failure";
import { emitMascot, emitStep } from "./flow";
import type { InitOptions } from "./index";
import type { FeatureApply, OfferDeps } from "./offer-extras";
import { offerRegistryExtras, parseFeatureList } from "./offer-extras";
import type { LintToolOfferDeps } from "./offer-lint-tools";
import { offerLintTools } from "./offer-lint-tools";
import type { OverlayFramework } from "./overlay/adapters";
import { ADAPTERS, isOverlayFramework } from "./overlay/adapters";
import { applyLunoraOverlay, findExistingViteConfig, isLunoraDep } from "./overlay/apply";
import generateProjectName from "./project-name";
import { verifyRemoteTemplate } from "./verify";

/** Lunar-mission copy for the flow. Kept here so the tui and pail paths read identically. */
const COPY = {
    extras: "Let's finish setting up your app.",
    framework: "Which framework should we launch?",
    git: "Initialize a new git repository? (optional)",
    install: "Install dependencies now?",
    name: "Where should we land your project?",
    nextHeader: "Liftoff confirmed — explore your project!",
    packageManager: "Which package manager?",
} as const;

type Template =
    | "analog"
    | "astro"
    | "expo"
    | "next"
    | "nuxt"
    | "react-router"
    | "solid-v2"
    | "standalone"
    | "sveltekit"
    | "tanstack-start-react"
    | "tanstack-start-solid"
    | "vinext"
    | "vinext-pages";

interface InitCommandOptions {
    /**
     * Add features non-interactively after scaffolding (the `--add` flag): a
     * comma-separated list of `ai | auth | backup | browser | cloudflare-access | crons | email | flags | hyperdrive | payment | presence | queue | storage | workflow`.
     * Bypasses the interactive multi-select and sub-prompts —
     * each named feature is applied with its shipped defaults.
     */
    add?: string;

    /**
     * When true, accept `--source` values that don't start with `gh:` /
     * `github:` / `https://` or that contain `..`. Defaults to false; the CLI
     * gate exists to stop arbitrary filesystem / scheme sources from being
     * pulled without the caller opting in.
     */
    allowUnsafeSource?: boolean;
    /** When set, also scaffold a CI deploy pipeline for the given provider. */
    ci?: CiProvider;

    cwd?: string;

    /**
     * Walk the whole flow — prompts, task list, next-steps, mascot — but make no
     * changes: skip the template fetch/copy, the feature applies, the dependency
     * install, and `git init`. Each skipped action logs a `would …` line instead.
     */
    dryRun?: boolean;

    /**
     * Local directory containing the template subdirs (e.g. `vite/`,
     * `standalone/`). When provided, skips the network fetch entirely.
     * Useful for offline runs, the clean-machine smoke test, and unit tests.
     */
    from?: string;

    /**
     * When true, configure Lunora into the CURRENT project (`cwd`) instead of
     * scaffolding a new directory. Finds an existing `vite.config.*` and
     * patches it via `patchViteConfig`, or creates a minimal one when absent.
     * All other scaffold options (`name`, `templateType`, `source`, `from`)
     * are ignored in this mode.
     */
    inPlace?: boolean;

    /**
     * Inject the post-scaffold install offer's prompts (tests). When set, the
     * offer runs regardless of TTY: `confirmInstall` drives the yes/no, and
     * `selectManager` picks among the detected managers.
     */
    installPrompt?: {
        confirmInstall: () => Promise<boolean>;
        selectManager: (managers: ReadonlyArray<PackageManager>) => Promise<PackageManager>;
    };

    /**
     * Force the post-scaffold "add auth / email?" offer on (the `--interactive`
     * flag). When omitted, the offer runs only when stdin is a TTY. `--yes`
     * suppresses it regardless. Has no effect once {@link prompt} is injected.
     */
    interactive?: boolean;

    /**
     * Test seam for the lint/formatter multi-select. Separate from {@link prompt}
     * because that one is pinned to the feature-offer's value union — reusing it
     * here would only typecheck through a cast.
     */
    lintPrompt?: LintToolOfferDeps["multiSelect"];

    logger: Logger;

    name?: string;

    /**
     * Local directory holding create-vite bases (one `template-<id>/` subdir per
     * framework). When set with `vite`, the overlay copies the base from disk
     * instead of fetching `create-vite` over the network — offline mode + tests.
     */
    overlayBaseFrom?: string;

    /** Probe for which package managers are installed (tests). Defaults to a real `<pm> --version` check. */
    packageManagerProbe?: PackageManagerProbe;

    /**
     * Inject the offer's prompts (tests). When set, the offer is treated as
     * interactive regardless of TTY, and these drive the feature multi-select,
     * the auth-provider sub-select, and the storage bucket-name text input.
     */
    prompt?: Pick<OfferDeps, "multiSelect" | "select" | "text">;

    /**
     * Override the git ref (branch, tag, or commit) the default template source
     * is fetched from. Takes precedence over the version-derived ref. Ignored
     * when `source` or `from` is set.
     */
    ref?: string;

    /** Local registry root for the offer's `runAddCommand` (offline / tests). Mirrors `from` but for registry items. */
    registryFrom?: string;
    /** Override the remote registry source base for the offer (default `gh:anolilab/lunora/registry`). */
    registrySource?: string;

    /**
     * Override the remote source giget downloads from. Default:
     * `gh:anolilab/lunora/templates/<templateType>#<ref>`, where `<ref>` is
     * the `ref` option when set, else derived from the CLI version (pre-release
     * channels → their branch, stable → `main`). Tests typically use `from`
     * instead to skip the network.
     */
    source?: string;

    /** Spawner for the post-scaffold dependency install (tests inject a recording stub). Defaults to a real subprocess. */
    spawner?: Spawner;

    templateType?: Template;

    /**
     * Scaffold via the **create-vite overlay** for this framework (`react`,
     * `vue`, `solid`, `svelte`, `vanilla`) instead of a bespoke template: fetch
     * the official create-vite base and apply the Lunora layer on top. Takes
     * precedence over `templateType`.
     */
    vite?: string;

    /** Suppress the offer entirely (the `--yes` flag): scaffold only, print the later-setup hint. */
    yes?: boolean;
}

interface InitCommandResult {
    code: number;
    files: ReadonlyArray<string>;
    target: string;
}

const TEXT_EXTENSIONS = new Set([".gitignore", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"]);

/** Minimal vite config written when none exists during in-place init. */
const MINIMAL_VITE_CONFIG = `import { defineConfig } from "vite";
import { lunora } from "@lunora/vite";

export default defineConfig({ plugins: [lunora()] });
`;

/** Sample `lunora/schema.ts` written when scaffolding Lunora into an existing app. */
const SAMPLE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),
});
`;

/** Sample `lunora/messages.ts` (one query + one mutation) written alongside the schema. */
const SAMPLE_FUNCTION = `import { mutation, query, v } from "./_generated/server";

export const list = query
    .input({ channelId: v.id("channels"), limit: v.optional(v.number()) })
    .query(async ({ args }) => {
        return { channelId: args.channelId, limit: args.limit ?? 50, messages: [] };
    });

export const send = mutation
    .input({ channelId: v.id("channels"), text: v.string() })
    .mutation(async ({ args }) => {
        return { channelId: args.channelId, text: args.text };
    });
`;

const DEFAULT_SOURCE_BASE = "gh:anolilab/lunora/templates";

const isTextFile = (filePath: string): boolean => {
    const lastDot = filePath.lastIndexOf(".");

    if (lastDot === -1) {
        return false;
    }

    return TEXT_EXTENSIONS.has(filePath.slice(lastDot));
};

const substitute = (content: string, name: string): string => content.replaceAll("{{name}}", name);

/**
 * Resolve every `@lunora/*` + `lunorash` dependency declared across the template's
 * `package.json` files to the CONCRETE version its `distTag` currently points at
 * (one registry lookup per package, in parallel). Scaffolds pin this exact version
 * rather than the floating tag — a tag lets a stale lockfile / pnpm metadata cache
 * silently install an older release (the specifier still matches, so the lockfile
 * is never re-resolved). A package whose lookup fails is simply absent from the
 * map, and {@link stampLunoraDeps} falls back to the tag for it (offline-safe).
 */
const resolveLunoraVersions = async (files: ReadonlyArray<string>, distTag: string): Promise<ReadonlyMap<string, string>> => {
    const names = new Set<string>();

    for (const file of files) {
        if (basename(file) !== "package.json") {
            continue;
        }

        try {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

            for (const section of ["dependencies", "devDependencies"] as const) {
                for (const name of Object.keys(parsed[section] ?? {})) {
                    if (isLunoraDep(name)) {
                        names.add(name);
                    }
                }
            }
        } catch {
            // Unparseable package.json — skip; stamping leaves it untouched too.
        }
    }

    return resolveTagVersions(names, distTag);
};

/**
 * Rewrite the `@lunora/*` + `lunorash` dependency ranges in a template's
 * `package.json` to the CLI's release-channel dist-tag.
 *
 * Templates pin these at the `^0.0.0` placeholder so the monorepo's own tooling
 * stays version-agnostic, but that placeholder resolves to an empty stub package
 * on a consumer machine (and on a pre-release channel the `latest` tag is itself
 * a placeholder). Stamping each Lunora-scoped range to {@link resolveDistTag}
 * wires a scaffolded project to the same channel the running CLI shipped on —
 * the same fix `resolveDepRange` applies to registry-added deps. Non-Lunora deps
 * (react, vite, wrangler, …) are left untouched. Structural jsonc edits preserve
 * the file's formatting; a parse failure leaves the text unchanged.
 */
const stampLunoraDeps = (packageJsonText: string, distTag: string, versions: ReadonlyMap<string, string>): string => {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    try {
        parsed = JSON.parse(packageJsonText) as typeof parsed;
    } catch {
        return packageJsonText;
    }

    let text = packageJsonText;

    for (const section of ["dependencies", "devDependencies"] as const) {
        for (const name of Object.keys(parsed[section] ?? {})) {
            if (!isLunoraDep(name)) {
                continue;
            }

            // Pin the concrete resolved version when available; fall back to the
            // floating dist-tag (offline / lookup failed).
            const pin = versions.get(name) ?? distTag;
            const edits = modify(text, [section, name], pin, { formattingOptions: { insertSpaces: true, tabSize: 4 } });

            text = applyEdits(text, edits);
        }
    }

    return text;
};

/**
 * Native build scripts the scaffold's toolchain needs to run on install, pulled
 * in by Vite + Wrangler: `workerd`/`esbuild`/`@parcel/watcher`/`msgpackr-extract`
 * (wrangler + miniflare), `unrs-resolver`/`rs-module-lexer` (Vite 8 / rolldown),
 * and `sharp` (image handling). pnpm v10+ blocks post-install build scripts by
 * default; pre-approving them lets `pnpm install` run exactly these without the
 * interactive `pnpm approve-builds` step — otherwise the user's first install
 * halts with `ERR_PNPM_IGNORED_BUILDS`. Kept in sync with the repo root's
 * `allowBuilds` set and `scripts/template-build-smoke.sh`.
 */
const PNPM_BUILT_DEPENDENCIES: ReadonlyArray<string> = [
    "@parcel/watcher",
    "esbuild",
    "lmdb",
    "msgpackr-extract",
    "rs-module-lexer",
    "sharp",
    "unrs-resolver",
    // `@lunora/client` → `@visulima/storage-client` → `@tanstack/vue-query` →
    // `vue-demi`, whose postinstall points its shim at the installed Vue major.
    // Every scaffold gets it, including `standalone` (which has no UI framework
    // at all), so leaving it unlisted halted the very first `pnpm install`.
    // Pure JS and self-swallowing, so it is allowed rather than denied.
    "vue-demi",
    "workerd",
];

/**
 * Build scripts present in the dependency tree (via `wrangler`'s transitive deps)
 * that we explicitly DENY rather than run: they're optional native
 * optimizations, not needed by a scaffolded app, and building them would require
 * a C/C++ toolchain a fresh clone may not have (`cpu-features` → node-gyp).
 * `ssh2` falls back to pure JS without its optional `cpu-features`; `protobufjs`'s
 * postinstall is a codegen the CLI paths don't need. They must still be LISTED —
 * pnpm v11 errors on any unlisted build script when an `allowBuilds` map exists —
 * so denying (`false`) keeps `pnpm install` non-interactive AND compiler-free.
 */
const PNPM_DENIED_BUILD_DEPENDENCIES: ReadonlyArray<string> = ["cpu-features", "protobufjs", "ssh2"];

/** File pnpm reads its settings from. */
const PNPM_WORKSPACE_FILENAME = "pnpm-workspace.yaml";

/**
 * The `pnpm-workspace.yaml` written into a scaffold so `pnpm install` builds the
 * toolchain's native deps without `pnpm approve-builds`. This is the new home for
 * the setting — pnpm v10.16+ NO LONGER reads the `package.json` `pnpm` field.
 *
 * Uses the `allowBuilds` map (`name: true|false`) — the key pnpm v11's
 * `approve-builds` writes and honours; the older `onlyBuiltDependencies` array is
 * NOT honoured by pnpm 11.x at install time. Every build-script package in the
 * tree must be listed (allowed or denied) or pnpm halts with
 * `ERR_PNPM_IGNORED_BUILDS`. npm/yarn ignore the file.
 */
const pnpmWorkspaceYaml = (): string =>
    [
        "# pnpm reads its settings from here (the package.json `pnpm` field is no longer read).",
        "# Pre-approve the toolchain's native build scripts so `pnpm install` runs them",
        "# without the interactive `pnpm approve-builds` step; deny the optional native",
        "# builds a scaffold doesn't need (so no C/C++ toolchain is required).",
        "allowBuilds:",
        ...PNPM_BUILT_DEPENDENCIES.map((name) => `    '${name}': true`),
        ...PNPM_DENIED_BUILD_DEPENDENCIES.map((name) => `    '${name}': false`),
        "",
    ].join("\n");

const collectFiles = (directory: string): ReadonlyArray<string> => {
    const out: string[] = [];

    for (const entry of walkSync(directory, { includeDirs: false, includeFiles: true })) {
        // Skip symlinks: a hostile `--source`/`--from` template could ship a
        // symlink to e.g. `~/.ssh/id_rsa`, and reading THROUGH it would copy the
        // victim's private file into the scaffolded project. We only ever copy
        // real regular files from a template.
        if (lstatSync(entry.path).isSymbolicLink()) {
            continue;
        }

        out.push(entry.path);
    }

    return out;
};

/** The upstream repo `lunora init --vite` fetches its stock create-vite base from. */
const CREATE_VITE_REPO = "vitejs/vite";

/**
 * Copy every REAL file under `source` into `target`, preserving the tree.
 *
 * Deliberately not `cpSync(..., { recursive: true })`: that reproduces symlinks
 * verbatim, so a base carrying a link to `~/.ssh/id_rsa` plants that link inside
 * the user's fresh project. {@link collectFiles} already drops symlinks for the
 * bespoke-template path; this is the same rule for the create-vite base, which
 * comes from a third-party repo at a moving ref.
 */
const copyRealFiles = (source: string, target: string): void => {
    for (const file of collectFiles(source)) {
        const destination = join(target, relative(source, file));

        mkdirSync(dirname(destination), { recursive: true });
        // `copyFileSync` reads through the source path; `collectFiles` has
        // already guaranteed it is a regular file, never a link.
        copyFileSync(file, destination);
    }
};

const copyTemplate = async (sourceDirectory: string, target: string, name: string): Promise<ReadonlyArray<string>> => {
    const files = collectFiles(sourceDirectory);
    const written: string[] = [];
    const distTag = resolveDistTag();

    // Resolve each Lunora dep's tag → concrete version once, up front, so the
    // scaffold pins exact versions instead of the floating tag (see
    // resolveLunoraVersions). Network best-effort; falls back to the tag per dep.
    const versions = await resolveLunoraVersions(files, distTag);

    for (const source of files) {
        const relativePath = relative(sourceDirectory, source);
        const destination = join(target, relativePath);

        mkdirSync(dirname(destination), { recursive: true });

        const raw = readFileSync(source);
        let text = isTextFile(source) ? substitute(raw.toString("utf8"), name) : undefined;

        // Pin the template's `@lunora/*` + `lunorash` placeholder ranges to the
        // concrete published version (falling back to the CLI's release channel
        // tag) so the scaffold installs real code, not the `^0.0.0` stub. Other
        // deps and non-package.json files pass through.
        if (text !== undefined && basename(source) === "package.json") {
            text = stampLunoraDeps(text, distTag, versions);
        }

        if (text === undefined) {
            writeFileSync(destination, raw);
        } else {
            writeFileSync(destination, text, "utf8");
        }

        written.push(destination);
    }

    return written;
};

const resolveTemplateSource = (templateType: Template, source: string | undefined, ref: string | undefined): string => {
    if (source !== undefined && source.length > 0) {
        return source;
    }

    return `${DEFAULT_SOURCE_BASE}/${templateType}#${resolveSourceRef(ref)}`;
};

/**
 * Defence-in-depth gate over `--source`. Refuses sources containing `..`
 * (path traversal) or sources that don't start with one of the supported
 * provider schemes. `--allow-unsafe-source` exists for users who genuinely
 * need a local-disk or custom-scheme source.
 */
const isSafeSource = (source: string): boolean => {
    if (source.includes("..")) {
        return false;
    }

    return source.startsWith("gh:") || source.startsWith("github:") || source.startsWith("https://");
};

/** One consistent `[dry-run] would …` line for every skipped side effect. */
const logWould = (logger: Logger, action: string): void => {
    logger.info(`[dry-run] would ${action}`);
};

const logScaffoldSuccess = (logger: Logger, written: ReadonlyArray<string>, target: string): void => {
    // Cosmetic blank line above the success so it isn't glued to the task
    // checklist — TTY only, so piped / JSON output stays clean.
    if (isInteractive()) {
        process.stdout.write("\n");
    }

    logger.success(`scaffolded ${String(written.length)} files into ${target}`);
};

/** The shell command that adds dependencies with `manager` (`pnpm add …`, `npm install …`, …). */
const installCommand = (manager: PackageManager, packages: ReadonlyArray<string>): string => {
    const { args, command } = addArgsFor(manager, packages);

    return `${command} ${args.join(" ")}`;
};

/** Walk up from `startDirectory` until `matches` holds for a directory, or the filesystem root is reached. */
const anyAncestor = (startDirectory: string, matches: (directory: string) => boolean): boolean => {
    let directory = resolve(startDirectory);

    for (;;) {
        if (matches(directory)) {
            return true;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return false;
        }

        directory = parent;
    }
};

/** A workspace root: a `pnpm-workspace.yaml`, or a `package.json` with a `workspaces` field. */
const isWorkspaceRoot = (directory: string): boolean => {
    if (existsSync(join(directory, PNPM_WORKSPACE_FILENAME))) {
        return true;
    }

    const packagePath = join(directory, "package.json");

    if (!existsSync(packagePath)) {
        return false;
    }

    try {
        return (JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown }).workspaces !== undefined;
    } catch {
        // Unreadable / invalid package.json — not a workspace root we can trust.
        return false;
    }
};

/**
 * Whether `startDirectory` sits inside a workspace. Used to skip the dependency
 * install offer: a freshly-scaffolded package isn't listed in the workspace yet,
 * so installing from inside it won't resolve `workspace:` deps — the user must
 * install from the repo root after wiring it in.
 */
const isInsideMonorepo = (startDirectory: string): boolean => anyAncestor(startDirectory, isWorkspaceRoot);

/** Whether `startDirectory` already sits inside a git work-tree (an ancestor has a `.git`). */
const isInsideGitRepo = (startDirectory: string): boolean => anyAncestor(startDirectory, (directory) => existsSync(join(directory, ".git")));

/**
 * After scaffolding, optionally `git init` the new project — create-astro's git
 * step. Only on a real TTY (never CI / `--yes`), and skipped when the project is
 * already inside a git work-tree (e.g. scaffolded into an existing repo or this
 * monorepo), since a nested repo there is rarely what you want.
 */
const maybeOfferGit = async (options: InitCommandOptions, target: string): Promise<void> => {
    if (options.yes === true || !isInteractive() || isInsideGitRepo(dirname(target))) {
        return;
    }

    if (!(await tuiConfirm(COPY.git, { badge: BADGES.git, defaultYes: false }))) {
        await tuiInfo("Sounds good! You can always run git init manually.");

        return;
    }

    if (options.dryRun === true) {
        logWould(options.logger, "initialize a git repository");

        return;
    }

    const spawner = options.spawner ?? defaultSpawner;
    const result = await withTuiSpinner("Initializing a git repository…", () => spawner({ args: ["init"], command: "git", cwd: target }));

    if (result.code === 0) {
        await emitStep("git", "Initialized an empty git repository.");
    } else {
        options.logger.warn("`git init` failed — initialize it yourself later with `git init`.");
    }
};

/**
 * Print the post-scaffold "next steps". When deps were already installed (the
 * user accepted the install offer), the `install` line is dropped and the `dev`
 * line uses the chosen manager; otherwise the caller passes the detected manager
 * (lock file / `packageManager` field / launching manager / first installed).
 * Inside a monorepo we point at the workspace root, since installing in the new
 * package before it's wired into the workspace won't work.
 */
const printNextSteps = async (name: string, installed: PackageManager | undefined, manager: PackageManager, insideMonorepo: boolean): Promise<void> => {
    const steps: NextStep[] = [{ code: `cd ./${name}`, lead: "Enter your project directory using" }];

    if (installed === undefined) {
        steps.push({ code: `${manager} install`, lead: "Install dependencies with", tail: insideMonorepo ? " from the workspace root" : undefined });
    }

    steps.push(
        { code: runScriptCommand(manager, "dev"), lead: "Run", tail: " to start the dev server." },
        { code: "lunora add", lead: "Add features like auth or storage using" },
    );

    const help: NextStep[] = [
        { code: "https://lunora.sh/docs", lead: "Read the docs at" },
        { code: "https://lunora.sh/chat", lead: "Stuck? Join the chat at" },
    ];

    if (isInteractive()) {
        await tuiNextSteps(BADGES.next, COPY.nextHeader, steps, help);

        return;
    }

    const lines = steps.map((step) => `${step.lead} ${step.code}${step.tail ?? ""}`);

    lines.push("", ...help.map((line) => `${line.lead} ${line.code}${line.tail ?? ""}`));

    await emitStep("next", COPY.nextHeader, lines.join("\n"));
};

/** The install offer runs only on a real TTY or when its prompts are injected (tests) — never auto-installs in CI. */
const offerInstallIsInteractive = (options: InitCommandOptions): boolean => options.yes !== true && (options.installPrompt !== undefined || isInteractive());

/**
 * After a successful scaffold, offer to install dependencies. Detects the
 * installed package managers (pnpm > bun > yarn > npm), confirms, then — when
 * more than one is available — lets the user pick (defaulting to the most
 * preferred). Returns the manager that installed, or `undefined` when skipped or
 * on failure (the scaffold still succeeds either way).
 */
const maybeOfferInstall = async (options: InitCommandOptions, target: string): Promise<PackageManager | undefined> => {
    if (!offerInstallIsInteractive(options)) {
        return undefined;
    }

    // Inside a monorepo, don't offer to install: the new package isn't part of the
    // workspace yet, so an install from here can't resolve its `workspace:` deps.
    // The next-steps hint points the user at the workspace root instead.
    if (isInsideMonorepo(dirname(target))) {
        return undefined;
    }

    const managers = detectInstalledManagers(options.packageManagerProbe);
    const [defaultManager] = managers;

    if (defaultManager === undefined) {
        // No package manager on PATH — nothing to offer; the next-steps hint covers it.
        return undefined;
    }

    const confirm = options.installPrompt?.confirmInstall ?? (async (): Promise<boolean> => tuiConfirm(COPY.install, { badge: BADGES.deps, defaultYes: true }));

    if (!(await confirm())) {
        await tuiInfo("No problem! Remember to install dependencies after setup.");

        return undefined;
    }

    let manager = defaultManager;

    if (managers.length > 1) {
        manager = options.installPrompt
            ? await options.installPrompt.selectManager(managers)
            : ((await tuiSelect(
                  COPY.packageManager,
                  managers.map((candidate) => {
                      return { label: candidate, value: candidate };
                  }),
                  { badge: BADGES.deps, default: defaultManager },
              )) ?? defaultManager);
    }

    if (options.dryRun === true) {
        // Walk the prompts but install nothing; next-steps still lists install.
        logWould(options.logger, `install dependencies with ${manager}`);

        return undefined;
    }

    // Only when pnpm is the chosen manager: write the build-script allowlist to
    // pnpm-workspace.yaml just before the install (pnpm v10.16+ no longer reads
    // the package.json `pnpm` field), so `pnpm install` runs the toolchain's
    // native builds (esbuild/sharp/workerd) without a follow-up
    // `pnpm approve-builds`. npm/yarn scaffolds don't get a stray pnpm file.
    if (manager === "pnpm") {
        const workspacePath = join(target, PNPM_WORKSPACE_FILENAME);

        if (!existsSync(workspacePath)) {
            writeFileSync(workspacePath, pnpmWorkspaceYaml(), "utf8");
        }
    }

    const spawner = options.spawner ?? defaultSpawner;
    const { args, command } = installArgsFor(manager);

    // Stream the package manager's OWN output straight through (the spawner
    // inherits stdio) — NOT behind a TUI spinner. An Ink spinner owns the
    // terminal, so it garbles the manager's live progress and blocks any prompt
    // it shows (e.g. pnpm's build-script approval). `emitStep` also gives the
    // line its own breathing room, so the manager output is cleanly separated
    // from the package-manager answer above it.
    await emitStep("deps", `Installing dependencies with ${manager}…`);

    const result = await spawner({ args, command, cwd: target });

    if (result.code !== 0) {
        options.logger.warn(`\`${command} install\` exited with code ${String(result.code)} — run it yourself in ${basename(target)}/.`);

        return undefined;
    }

    await emitStep("deps", `Dependencies installed with ${manager}.`);

    return manager;
};

const scaffoldFromLocal = async (fromRoot: string, templateType: Template, target: string, name: string, logger: Logger): Promise<InitCommandResult> => {
    const templateDirectory = join(fromRoot, templateType);

    if (!existsSync(templateDirectory)) {
        logger.error(`template not found in local source: ${templateDirectory}`);

        return { code: 1, files: [], target };
    }

    const written = await copyTemplate(templateDirectory, target, name);

    logScaffoldSuccess(logger, written, target);

    return { code: 0, files: written, target };
};

/**
 * Remote-fetch path: giget pulls the template into a scratch dir, we
 * substitute `{{name}}` into text files, then move them into `target`.
 * Going through a scratch dir keeps the substitution + collision logic
 * identical to the local path so we have one rule for "what counts as a
 * text file" and one place that decides the destination layout.
 */
const scaffoldFromRemote = async (options: {
    logger: Logger;
    name: string;
    ref: string | undefined;
    source: string | undefined;
    target: string;
    templateType: Template;
}): Promise<InitCommandResult> => {
    const { logger, name, ref, source, target, templateType } = options;
    const stagingRoot = mkdtempSync(join(tmpdir(), "lunora-init-fetch-"));
    const stagingDirectory = join(stagingRoot, "template");

    try {
        // Pin the moving release branch to the immutable commit it currently
        // points at before giget fetches it (supply-chain hardening) — logs the
        // SHA, or warns + falls back to the branch when the pin can't be resolved
        // (offline / rate-limited). A custom `--source` isn't part of the pinnable
        // `gh:anolilab/lunora` repo (and drops the ref entirely), so skip it.
        const pinnedRef = source !== undefined && source.length > 0 ? ref : await resolvePinnedSourceRef(ref, logger);
        const remote = resolveTemplateSource(templateType, source, pinnedRef);

        // Fetch + scaffold as a live checklist ("Project initialized!" with ✔ rows,
        // create-astro style; off a TTY the tasks run bare so CI/tests stay clean).
        let downloaded: { commit?: string; dir: string; source: string } | undefined;
        let written: ReadonlyArray<string> = [];

        await tuiTasks(
            [
                {
                    label: `${templateType} template fetched`,
                    run: async () => {
                        downloaded = await downloadTemplate(remote, {
                            cwd: stagingRoot,
                            dir: stagingDirectory,
                            force: true,
                            install: false,
                            silent: true,
                        });
                    },
                },
                {
                    label: `files copied into ${name}/`,
                    run: async () => {
                        written = await copyTemplate(stagingDirectory, target, name);
                    },
                },
            ],
            { end: "Project initialized!", start: "Project initializing…" },
        );

        const staged = collectFiles(stagingDirectory);

        // Cosmetic blank line above the provenance note (TTY only, so it doesn't
        // glue to the task checklist) — keeps piped / JSON output clean.
        if (isInteractive()) {
            process.stdout.write("\n");
        }

        // One concise provenance line so the user can still audit what was pulled.
        logger.info(
            downloaded?.commit
                ? `template: ${downloaded.source} @ ${downloaded.commit} (${String(staged.length)} files)`
                : `template: ${downloaded?.source ?? remote} (${String(staged.length)} files)`,
        );

        logScaffoldSuccess(logger, written, target);

        return { code: 0, files: written, target };
    } catch (error) {
        if (error instanceof PromptCancelledError) {
            throw error;
        }

        const { hints, message } = describeDownloadFailure(error, {
            ref: resolveSourceRef(ref),
            remote: resolveTemplateSource(templateType, source, ref),
            templateType,
        });

        logger.error(message);

        for (const hint of hints) {
            logger.warn(hint);
        }

        return { code: 1, files: [], target };
    } finally {
        rmSync(stagingRoot, { force: true, recursive: true });
    }
};

/** Mirror create-vite's dotfile rename — it stores `.gitignore` etc. with a leading `_` and renames on scaffold. */
const renameCreateViteDotfiles = (directory: string): void => {
    for (const file of ["_gitignore", "_npmrc", "_gitattributes"]) {
        const from = join(directory, file);

        if (existsSync(from)) {
            renameSync(from, join(directory, `.${file.slice(1)}`));
        }
    }
};

/**
 * Overlay path: scaffold a fresh `create-vite` base for `framework` into
 * `target`, then apply the Lunora overlay. The base comes from disk
 * (`overlayBaseFrom`, offline/tests) or `create-vite` over the network.
 */
const scaffoldViteOverlay = async (options: {
    framework: OverlayFramework;
    logger: Logger;
    name: string;
    overlayBaseFrom: string | undefined;
    target: string;
}): Promise<InitCommandResult> => {
    const { framework, logger, name, overlayBaseFrom, target } = options;
    const adapter = ADAPTERS[framework];
    const stagingRoot = mkdtempSync(join(tmpdir(), "lunora-vite-base-"));

    try {
        // The local-base validation stays an early return so the exact error is
        // preserved; only the actual file work runs inside the task checklist.
        let localBase: string | undefined;

        if (overlayBaseFrom !== undefined) {
            localBase = join(overlayBaseFrom, `template-${adapter.createViteTemplate}`);

            if (!existsSync(localBase)) {
                logger.error(`create-vite base not found on disk: ${localBase}`);

                return { code: 1, files: [], target };
            }
        }

        const copyBase = async (): Promise<void> => {
            if (localBase !== undefined) {
                copyRealFiles(localBase, target);

                return;
            }

            const stagingDirectory = join(stagingRoot, "base");
            // Pin `main` to the commit it points at right now, the same way the
            // bespoke template path pins its own repo: the base is third-party
            // code copied verbatim into the user's project, so the SHA it came
            // from is logged and auditable. Falls back to the branch (with a
            // warning) when the API can't be reached.
            const baseRef = await resolvePinnedRepoRef(CREATE_VITE_REPO, "main", logger);
            const remote = `github:${CREATE_VITE_REPO}/packages/create-vite/template-${adapter.createViteTemplate}#${baseRef}`;

            await downloadTemplate(remote, { cwd: stagingRoot, dir: stagingDirectory, force: true, install: false, silent: true });
            renameCreateViteDotfiles(stagingDirectory);
            copyRealFiles(stagingDirectory, target);
        };

        let written: ReadonlyArray<string> = [];

        await tuiTasks(
            [
                { label: `create-vite (${adapter.label}) base ready`, run: copyBase },
                {
                    label: `Lunora overlay applied (${adapter.label})`,
                    run: async () => {
                        written = await applyLunoraOverlay({ adapter, distTag: resolveDistTag(), logger, name, target });
                    },
                },
            ],
            { end: "Project initialized!", start: "Project initializing…" },
        );

        logScaffoldSuccess(logger, written, target);

        return { code: 0, files: [...collectFiles(target)], target };
    } catch (error) {
        if (error instanceof PromptCancelledError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);

        logger.error(`failed to scaffold the ${adapter.label} base: ${message}`);

        return { code: 1, files: [], target };
    } finally {
        rmSync(stagingRoot, { force: true, recursive: true });
    }
};

/** Failed in-place init result: log the I/O failure (`verb` = "read" / "write") and abort. */
const inPlaceIoFailure = (verb: string, path: string, error: unknown, cwd: string, logger: Logger): InitCommandResult => {
    logger.error(`init --in-place: could not ${verb} ${path}: ${error instanceof Error ? error.message : String(error)}`);

    return { code: 1, files: [], target: cwd };
};

/**
 * Create a minimal vite.config.ts when no vite config exists in `cwd`.
 * Returns the InitCommandResult for the in-place path.
 */
const createMinimalViteConfig = (cwd: string, logger: Logger): InitCommandResult => {
    const target = join(cwd, "vite.config.ts");

    try {
        writeFileSync(target, MINIMAL_VITE_CONFIG, "utf8");
    } catch (error) {
        return inPlaceIoFailure("write", target, error, cwd, logger);
    }

    logger.success(`created ${target} with lunora() plugin`);

    return { code: 0, files: [target], target: cwd };
};

/**
 * Patch an existing vite config file in-place: read it, call patchViteConfig,
 * and write back when changed. Logs the outcome either way.
 */
const patchExistingViteConfig = (viteConfigPath: string, cwd: string, logger: Logger): InitCommandResult => {
    let source: string;

    try {
        source = readFileSync(viteConfigPath, "utf8");
    } catch (error) {
        return inPlaceIoFailure("read", viteConfigPath, error, cwd, logger);
    }

    const result = patchViteConfig(source);

    if (!result.changed) {
        logger.info(`${viteConfigPath}: ${result.reason ?? "no changes needed"}`);

        return { code: 0, files: [], target: cwd };
    }

    try {
        writeFileSync(viteConfigPath, result.code, "utf8");
    } catch (error) {
        return inPlaceIoFailure("write", viteConfigPath, error, cwd, logger);
    }

    logger.success(`patched ${viteConfigPath} — added lunora() plugin`);

    return { code: 0, files: [viteConfigPath], target: cwd };
};

/**
 * Scaffold `lunora/{schema,messages}.ts` into `cwd` when absent. Idempotent:
 * an existing `lunora/schema.ts` is left untouched and reported, so re-running
 * `lunora init --here` never double-patches the schema. Returns the list of
 * files actually written (empty when the directory already had a schema).
 */
const scaffoldLunoraDirectory = (cwd: string, logger: Logger): ReadonlyArray<string> => {
    const lunoraDirectory = join(cwd, "lunora");
    const schemaPath = join(lunoraDirectory, "schema.ts");

    if (existsSync(schemaPath)) {
        logger.info(`lunora/ already present — left ${schemaPath} untouched`);

        return [];
    }

    const written: string[] = [];

    try {
        mkdirSync(lunoraDirectory, { recursive: true });
        writeFileSync(schemaPath, SAMPLE_SCHEMA, "utf8");
        written.push(schemaPath);

        const functionPath = join(lunoraDirectory, "messages.ts");

        // The function file is only written when missing so a hand-edited one is
        // never clobbered on a re-run.
        if (!existsSync(functionPath)) {
            writeFileSync(functionPath, SAMPLE_FUNCTION, "utf8");
            written.push(functionPath);
        }

        logger.success(`scaffolded lunora/ (${String(written.length)} file(s))`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`init --here: could not scaffold lunora/: ${message}`);
    }

    return written;
};

/**
 * Per-framework "next steps" copy printed after the in-place patch. Each entry
 * names the idiomatic Lunora adapter to install and the composition wiring
 * the user must add by hand (worker `httpRouter` for class A, hook-injection for
 * class B). This is the honest "auto-patched vs instructed" boundary: the CLI
 * scaffolds `lunora/` and patches the Vite config; the provider + worker
 * composition is printed for the user to wire because it is framework-specific
 * and lives in files the CLI does not own.
 */
const printFrameworkNextSteps = (detection: FrameworkDetection, manager: PackageManager, logger: Logger): void => {
    const { adapter, class: frameworkClass, framework } = detection;

    logger.info("");
    logger.info(`detected framework: ${framework} (class ${frameworkClass})`);
    logger.info("next steps:");
    logger.info(`  1. install the adapter:  ${installCommand(manager, [adapter, "@lunora/client", "@lunora/runtime", "@lunora/server"])}`);
    logger.info("  2. run codegen:          lunora codegen");

    if (frameworkClass === "A") {
        // Class A — Lunora owns the worker entry: drop the framework SSR handler
        // into createWorker({ httpRouter }).
        logger.info("  3. compose one worker:   wrap your worker entry with");
        logger.info("       createWorker({ httpRouter: <your framework SSR handler>, shardDO: ShardDO, ... })");
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout/route`);
        logger.info("  5. make a loader live:   preloadQuery() in a loader, usePreloadedQuery() in the component");
        logger.info("     see https://lunora.sh/docs/frameworks/reactive-loaders");
    } else if (frameworkClass === "B") {
        // Class B — the framework owns its CF adapter: Lunora realtime is injected
        // into the framework's server entry/hooks; it keeps the rest.
        logger.info("  3. inject Lunora:        mount Lunora realtime under /_lunora/* in your server hook");
        logger.info(`       (${framework} owns its Cloudflare adapter — Lunora composes into its server entry)`);
        logger.info(`  4. add the provider:     mount the ${adapter} provider in your root layout`);
        logger.info("  5. read the guide:       https://lunora.sh/docs/frameworks/deploy");
    } else {
        // Class C — SPA / SSR-less: client adapter + standalone Lunora worker.
        logger.info("  3. add the provider:     wrap your app with the LunoraProvider from @lunora/react");
        logger.info("  4. read the guide:       https://lunora.sh/docs/frameworks/bring-your-framework");
    }

    logger.info("");
};

/**
 * Patch (or create) the project's Vite config for the in-place path, skipping
 * the work for class-B frameworks that ship their own Cloudflare adapter and
 * wire Lunora through their server entry rather than a `lunora()` Vite plugin.
 * Returns the InitCommandResult so a hard write failure aborts the whole run.
 */
const patchOrCreateViteConfig = (cwd: string, framework: DetectedFramework, logger: Logger): InitCommandResult => {
    const viteConfigPath = findExistingViteConfig(cwd);

    if (viteConfigPath === undefined) {
        // SvelteKit/Nuxt own their build via their own config; don't drop a
        // standalone vite.config.ts on them. They get lunora/ + instructions only.
        if (framework === "sveltekit" || framework === "nuxt" || framework === "astro") {
            logger.info(`no Vite config found — ${framework} wires Lunora through its server entry (see next steps)`);

            return { code: 0, files: [], target: cwd };
        }

        return createMinimalViteConfig(cwd, logger);
    }

    return patchExistingViteConfig(viteConfigPath, cwd, logger);
};

/**
 * In-place mode: configure Lunora into an existing project at `cwd`. Detects the
 * meta-framework from `package.json`, patches/creates the Vite config where
 * applicable, scaffolds `lunora/` (schema + sample function) idempotently, and
 * prints framework-specific next steps (adapter install + provider/worker
 * wiring). Re-running is a no-op for already-patched pieces.
 *
 * Auto-patched: the Vite config (class A/C) and the `lunora/` scaffold.
 * Instructed: the adapter dependency, the provider mount, and the worker
 * `httpRouter` composition (class A) / hook injection (class B) — these live in
 * framework-owned files, so the CLI prints precise steps instead of guessing.
 */
const runInPlaceInit = (cwd: string, logger: Logger): InitCommandResult => {
    const detection = detectFramework(cwd);

    const viteResult = patchOrCreateViteConfig(cwd, detection.framework, logger);

    if (viteResult.code !== 0) {
        return viteResult;
    }

    const scaffolded = scaffoldLunoraDirectory(cwd, logger);

    // The overlay path patches an existing project, so honour its package
    // manager (packageManager field / lockfile) rather than assuming pnpm.
    printFrameworkNextSteps(detection, detectPackageManager(cwd), logger);

    return { code: 0, files: [...viteResult.files, ...scaffolded], target: cwd };
};

/**
 * Whether the post-scaffold offer should prompt. `--yes` always suppresses it;
 * otherwise it's on when prompts are injected (tests), the `--interactive` flag
 * is set, or — by default — stdin is a TTY.
 */
const offerIsInteractive = (options: InitCommandOptions): boolean =>
    options.yes !== true && (options.prompt !== undefined || (options.interactive ?? isInteractive()));

/**
 * Ask which linter/formatter the project uses and configure it to skip Lunora's
 * generated files. Runs last, after the feature offer, so the writers see the
 * final scaffolded `package.json` — a registry item may have pulled a lint tool
 * in, and detection is what pre-selects the prompt.
 */
const offerLintIgnores = async (projectDirectory: string, interactive: boolean, options: InitCommandOptions): Promise<void> => {
    // Every other post-scaffold step carries its own dry-run guard; this one
    // writes to the filesystem, so it needs the same. `--in-place --dry-run` is
    // the case that makes it matter: the target is the user's existing repo, not
    // a directory this run created, so an unguarded write lands in real work.
    if (options.dryRun === true) {
        return;
    }

    await offerLintTools({
        apply: (tools) => applyLintIgnores(projectDirectory, tools),
        detected: detectLintTools(projectDirectory),
        interactive,
        logger: options.logger,
        multiSelect: options.lintPrompt ?? ((message, choices, settings) => tuiMultiSelect(message, choices, { ...settings, badge: BADGES.add })),
    });
};

/**
 * Build the offer's real dependencies (readline prompts + `runAddCommand`) and
 * run the post-scaffold auth/email offer against `projectDir`. Interactive when
 * `--interactive` is set, prompts are injected (tests), or stdin is a TTY —
 * unless `--yes` suppresses it (then it prints the later-setup hint and applies
 * nothing).
 *
 * The INTERACTIVE offer is best-effort: a failed registry add is logged by
 * `runAddCommand` and never aborts the (already successful) scaffold. An
 * explicit `--add` is not — it exists for scripts, so returns `false` on failure
 * and that becomes the command's exit code.
 */
const maybeOfferExtras = async (options: InitCommandOptions, projectDirectory: string): Promise<boolean> => {
    const interactive = offerIsInteractive(options);
    const preselected =
        options.add === undefined
            ? []
            : parseFeatureList(options.add, (message) => {
                  options.logger.warn(message);
              });

    // Each registry apply mutates shared project files; the whole batch runs
    // behind ONE progress line whose label changes per feature (no-op off a TTY,
    // so tests/CI run bare). Behind the spinner the registry command's own
    // progress logging is muted — it writes to the same stdout the live spinner
    // repaints, which would garble the terminal — but errors/warnings still
    // surface. Off a TTY there's no spinner, so the full logger is kept and CI
    // retains the detail.
    const applyAll = async (plans: ReadonlyArray<FeatureApply>): Promise<boolean> => {
        if (plans.length === 0) {
            return true;
        }

        // --dry-run: report what would be added without touching the project.
        if (options.dryRun === true) {
            logWould(options.logger, `add ${plans.map((plan) => plan.label).join(", ")}`);

            return true;
        }

        // Warnings/errors raised mid-apply can't be written straight to stdout:
        // the live gradient spinner repaints the same lines, so an interleaved
        // write breaks Ink's cursor math and orphans the spinner frame (the
        // stacked "adding …" rows bug). Buffer them while the spinner is live and
        // replay after it unmounts, so they still surface — just cleanly, below
        // the settled `add` row.
        const buffered: { level: "error" | "warn"; message: string }[] = [];
        const applyLogger: Logger = isInteractive()
            ? {
                  error: (message) => {
                      buffered.push({ level: "error", message });
                  },
                  info: () => {},
                  success: () => {},
                  warn: (message) => {
                      buffered.push({ level: "warn", message });
                  },
              }
            : options.logger;

        const steps = plans.map((plan) => {
            return {
                running: `adding ${plan.label}…`,
                task: () =>
                    runAddCommand({
                        allowUnsafeSource: options.allowUnsafeSource,
                        cwd: projectDirectory,
                        from: options.registryFrom,
                        logger: applyLogger,
                        names: [...plan.names],
                        ref: options.ref,
                        source: options.registrySource,
                        transformManifest: plan.transformManifest,
                        yes: true,
                    }),
            };
        });

        const done = `added ${plans.map((plan) => plan.label).join(", ")}`;
        const results = await withTuiBadgeProgress(BADGES.add, steps, done);

        // Spinner is gone — now it's safe to surface anything the applies raised.
        for (const { level, message } of buffered) {
            options.logger[level](message);
        }

        return results.every((result) => result.code === 0);
    };

    const deps: OfferDeps = {
        applyAll,
        interactive,
        logger: options.logger,
        multiSelect: options.prompt?.multiSelect ?? ((message, choices, settings) => tuiMultiSelect(message, choices, { ...settings, badge: BADGES.add })),
        preselected: preselected.length > 0 ? preselected : undefined,
        projectName: basename(projectDirectory),
        // Detect the per-framework auth-UI item from the scaffolded template's deps.
        resolveAuthUiItem: () => {
            try {
                const pkg = JSON.parse(readFileSync(join(projectDirectory, "package.json"), "utf8")) as {
                    dependencies?: Record<string, string>;
                    devDependencies?: Record<string, string>;
                };

                return detectAuthUiItem({ ...pkg.dependencies, ...pkg.devDependencies }) ?? "auth-ui-react";
            } catch {
                return "auth-ui-react";
            }
        },
        select:
            options.prompt?.select ??
            ((message, choices, settings): Promise<FeatureItem | undefined> => tuiSelect(message, choices, { ...settings, badge: BADGES.add })),
        text: options.prompt?.text ?? ((message, settings) => tuiText(message, { ...settings, badge: BADGES.add })),
    };

    // `--add` applies its features directly (no headline, no multi-select).
    if (preselected.length > 0) {
        const added = await offerRegistryExtras(deps);

        await offerLintIgnores(projectDirectory, interactive, options);

        return added;
    }

    // A plain headline for the interactive offer (no badge, just the section
    // intro). TTY only — off a TTY the offer prints its own structured hint
    // through the logger, so we don't write raw copy to stdout (keeps piped /
    // JSON output clean).
    if (isInteractive()) {
        await tuiHeadline(COPY.extras);
    }

    await offerRegistryExtras(deps);
    await offerLintIgnores(projectDirectory, interactive, options);

    return true;
};

/** Default framework when none is specified — the React create-vite overlay. */
const DEFAULT_FRAMEWORK = "react";

/**
 * The frameworks offered in the interactive picker. The create-vite frameworks
 * (`react` / `vue` / `solid` / `svelte`) scaffold via the overlay engine — the
 * official create-vite base plus the Lunora layer — while the rest are bespoke
 * Lunora templates. (`vanilla` is overlay-only via `--vite`.)
 */
const FRAMEWORK_CHOICES: ReadonlyArray<{ description: string; label: string; value: string }> = [
    { description: "React SPA — official create-vite base + the Lunora layer (the default)", label: "React", value: "react" },
    { description: "Vue SPA — create-vite base + Lunora", label: "Vue", value: "vue" },
    { description: "Solid SPA — create-vite base + Lunora", label: "Solid", value: "solid" },
    // The Solid 2.0 line is a bespoke template rather than a `--vite` overlay:
    // create-vite's `solid-ts` base is still Solid 1.x, and 2.0 needs a
    // different renderer package, JSX source and Vite plugin major.
    { description: "Solid 2.0 SPA — the Solid 2 line (@solidjs/web, vite-plugin-solid 3)", label: "Solid 2", value: "solid-v2" },
    { description: "Svelte SPA — create-vite base + Lunora", label: "Svelte", value: "svelte" },
    { description: "Next.js (App Router) — OpenNext on Cloudflare + a standalone Lunora worker", label: "Next.js", value: "next" },
    { description: "TanStack Start (React) — SSR with live-loader routes", label: "TanStack Start · React", value: "tanstack-start-react" },
    { description: "TanStack Start (Solid)", label: "TanStack Start · Solid", value: "tanstack-start-solid" },
    { description: "Next.js App Router on Vite (vinext) — composed into the Lunora worker (experimental)", label: "vinext · App Router", value: "vinext" },
    { description: "Next.js Pages Router on Vite (vinext) — composed into one worker (experimental)", label: "vinext · Pages Router", value: "vinext-pages" },
    { description: "React Router (v7, framework mode) — SSR composed into the Lunora worker", label: "React Router", value: "react-router" },
    { description: "Astro + a standalone Lunora worker", label: "Astro", value: "astro" },
    { description: "AnalogJS (Angular) — single-worker, Lunora mounted in Nitro", label: "Analog", value: "analog" },
    { description: "Nuxt (Vue) — single-worker, Lunora mounted in Nitro", label: "Nuxt", value: "nuxt" },
    { description: "SvelteKit + a standalone Lunora worker", label: "SvelteKit", value: "sveltekit" },
    { description: "React Native (Expo) — an iOS/Android/web app + a Lunora worker backend", label: "React Native · Expo", value: "expo" },
    { description: "Worker only — no frontend", label: "Standalone", value: "standalone" },
];

/** create-vite overlay frameworks — passed via `--vite` (pipe-joined for the non-interactive error hint). */
const OVERLAY_VALUES = Object.keys(ADAPTERS).join("|");

/** Bespoke template ids — every {@link FRAMEWORK_CHOICES} value that is not a create-vite overlay. */
const TEMPLATE_IDS = FRAMEWORK_CHOICES.filter((choice) => !isOverlayFramework(choice.value)).map((choice) => choice.value);

/** Bespoke templates — passed via `-t` (pipe-joined for the non-interactive error hint). */
const TEMPLATE_VALUES = TEMPLATE_IDS.join("|");

/** What to scaffold: a create-vite overlay framework, or a bespoke Lunora template. */
type ScaffoldChoice = { framework: string; kind: "overlay" } | { kind: "template"; templateType: Template };

/** Map a picker/flag value to a scaffold choice — create-vite frameworks overlay, everything else is a bespoke template. */
const toScaffoldChoice = (value: string): ScaffoldChoice =>
    isOverlayFramework(value) ? { framework: value, kind: "overlay" } : { kind: "template", templateType: value as Template };

/**
 * Resolve what to scaffold. An explicit `--vite` framework or `-t` template
 * wins; otherwise an interactive run shows the framework picker, and a
 * `--yes` run takes the React overlay default. The non-interactive
 * "nothing specified + no --yes" case is rejected earlier by
 * {@link nonInteractiveInitError}, so it never reaches the silent default.
 */
const resolveScaffoldChoice = async (options: InitCommandOptions): Promise<ScaffoldChoice> => {
    if (options.vite !== undefined) {
        return { framework: options.vite, kind: "overlay" };
    }

    if (options.templateType !== undefined) {
        return { kind: "template", templateType: options.templateType };
    }

    if (!isInteractive() || options.yes === true) {
        return { framework: DEFAULT_FRAMEWORK, kind: "overlay" };
    }

    return toScaffoldChoice((await tuiSelect(COPY.framework, FRAMEWORK_CHOICES, { badge: BADGES.tmpl, default: DEFAULT_FRAMEWORK })) ?? DEFAULT_FRAMEWORK);
};

/**
 * In a non-interactive terminal `init` can't prompt for the name or template, so
 * require them on the command line instead of silently scaffolding `lunora-app`
 * with the default template. `--yes` opts into the defaults; an injected name +
 * templateType (tests) satisfies the check. Returns an error message, or
 * `undefined` when the run may proceed.
 */
const nonInteractiveInitError = (options: InitCommandOptions): string | undefined => {
    if (isInteractive() || options.yes === true) {
        return undefined;
    }

    const missing: string[] = [];

    if (options.name === undefined) {
        missing.push("a project name (`lunora init <name>`)");
    }

    if (options.templateType === undefined && options.vite === undefined) {
        missing.push(`a framework — \`--vite <${OVERLAY_VALUES}>\` for an SPA, or \`-t <${TEMPLATE_VALUES}>\` for a bespoke template`);
    }

    if (missing.length === 0) {
        return undefined;
    }

    return `lunora init can't prompt in a non-interactive terminal — provide ${missing.join(" and ")}, or pass --yes to accept the defaults.`;
};

/**
 * Overlay path: a create-vite framework (the default, `--vite`, or the picker)
 * fetches a stock create-vite base (over the network unless `overlayBaseFrom` is
 * set) and applies the Lunora layer on top.
 */
const scaffoldOverlayPath = async (options: InitCommandOptions, framework: string, name: string, target: string): Promise<InitCommandResult> => {
    if (!isOverlayFramework(framework)) {
        options.logger.error(`init: unknown framework "${framework}". Supported overlays: ${Object.keys(ADAPTERS).join(", ")}.`);

        return { code: 1, files: [], target };
    }

    if (!(await verifyRemoteTemplate({ isLocal: options.overlayBaseFrom !== undefined, logger: options.logger }))) {
        return { code: 1, files: [], target };
    }

    mkdirSync(target, { recursive: true });

    return scaffoldViteOverlay({ framework, logger: options.logger, name, overlayBaseFrom: options.overlayBaseFrom, target });
};

/**
 * Bespoke-template path: copy from `--from` (offline / tests), else fetch the
 * remote template with giget — verifying connectivity + the ref first so a bad
 * `--ref`/`--source` or being offline fails fast and clean.
 */
const scaffoldTemplatePath = async (options: InitCommandOptions, templateType: Template, name: string, target: string): Promise<InitCommandResult> => {
    if (options.from !== undefined) {
        return await scaffoldFromLocal(options.from, templateType, target, name, options.logger);
    }

    if (options.source !== undefined && options.source.length > 0 && !options.allowUnsafeSource && !isSafeSource(options.source)) {
        options.logger.error(
            `init: refusing --source ${options.source} — only gh:, github:, or https:// sources are allowed (and may not contain "..").` +
                " Re-run with --allow-unsafe-source if you really want this.",
        );

        return { code: 1, files: [], target };
    }

    if (!(await verifyRemoteTemplate({ isLocal: false, logger: options.logger, source: resolveTemplateSource(templateType, options.source, options.ref) }))) {
        return { code: 1, files: [], target };
    }

    return scaffoldFromRemote({ logger: options.logger, name, ref: options.ref, source: options.source, target, templateType });
};

const scaffoldNewProject = async (
    options: InitCommandOptions,
    cwd: string,
    recordTarget: (target: string, preExisted: boolean) => void,
): Promise<InitCommandResult> => {
    // Moonrise header, then create-astro-style linear questions: each prompt shows
    // its badge + question and collapses to a dimmed transcript line on submit.
    await tuiMoonrise("realtime backend on Cloudflare Workers + Durable Objects");

    const blocked = nonInteractiveInitError(options);

    if (blocked !== undefined) {
        options.logger.error(blocked);

        return { code: 1, files: [], target: "" };
    }

    // No name argument → ask for one (a TTY shows the prompt; with `--yes` /
    // non-interactive it takes the generated lunar default). A fresh fun name is
    // generated per run so an empty submit lands on something nicer than a static
    // placeholder (create-astro does the same).
    const suggestedName = generateProjectName();
    const rawName = options.name ?? (await tuiText(COPY.name, { badge: BADGES.dir, default: suggestedName, placeholder: suggestedName }));
    const choice = await resolveScaffoldChoice(options);

    // Guard against an empty / whitespace-only name: `options.name ?? …` only
    // falls back on null/undefined, so an explicit `--name ""` (or a
    // whitespace-only name) passes straight through. `resolve(cwd, "")`
    // resolves to cwd itself, and `resolve(cwd, "   ")` creates a confusing
    // whitespace-named directory — reject both up front.
    const name = rawName.trim();

    if (name.length === 0) {
        options.logger.error(`init: refusing an empty project name — pass a directory name (e.g. \`lunora init my-app\`).`);

        return { code: 1, files: [], target: "" };
    }

    // Guard the project name against path traversal: it becomes a directory
    // under cwd, so a name containing separators or `..` could scaffold outside
    // the intended parent. Mirrors the `--source` `isSafeSource` gate.
    if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
        options.logger.error(`init: refusing project name "${name}" — must not contain path separators or be "." / "..".`);

        return { code: 1, files: [], target: "" };
    }

    const target = resolve(cwd, name);
    const targetPreExisted = existsSync(target);

    if (targetPreExisted) {
        const entries = readdirSync(target);

        if (entries.length > 0) {
            options.logger.error(`target directory not empty: ${target}`);

            return { code: 1, files: [], target };
        }
    }

    // --dry-run: the prompts ran (so the flow is walked) but stop before any
    // writes. Report the would-be scaffold and return success; the offer /
    // install / git steps each have their own dry-run guard downstream.
    if (options.dryRun === true) {
        const what = choice.kind === "overlay" ? `the ${choice.framework} create-vite overlay` : `the ${choice.templateType} template`;

        logWould(options.logger, `scaffold ${what} into ${target}`);

        return { code: 0, files: [], target };
    }

    // From here we commit to writing into `target`. Record it so a Ctrl-C abort
    // can reset it (a dir we created is removed; a pre-existing empty dir is
    // emptied back out) — see `resetScaffoldOnCancel`.
    recordTarget(target, targetPreExisted);

    return choice.kind === "overlay"
        ? scaffoldOverlayPath(options, choice.framework, name, target)
        : scaffoldTemplatePath(options, choice.templateType, name, target);
};

/** Tracks the project directory a `lunora init` run creates, so a Ctrl-C abort can reset it. */
interface ScaffoldCleanup {
    target?: string;
    targetPreExisted?: boolean;
}

/**
 * Undo a partially-created scaffold after the user aborts (Ctrl-C): restore the
 * target back to its pre-run state. A directory we created is removed outright; a
 * directory that already existed (verified empty before we wrote into it) is
 * emptied back out but kept. A no-op when nothing was created yet (cancel during
 * the early prompts) or for in-place init (which never sets `cleanup.target`).
 */
const resetScaffoldOnCancel = (cleanup: ScaffoldCleanup, logger: Logger): void => {
    const { target, targetPreExisted } = cleanup;

    if (target === undefined || !existsSync(target)) {
        return;
    }

    if (targetPreExisted === true) {
        for (const entry of readdirSync(target)) {
            rmSync(join(target, entry), { force: true, recursive: true });
        }
    } else {
        rmSync(target, { force: true, recursive: true });
    }

    logger.info(`removed the partially-created project at ${target}`);
};

/** Run the scaffold step itself: in-place config, a `--dry-run` no-op, or a fresh-directory scaffold. */
const runScaffoldStep = async (
    options: InitCommandOptions,
    cwd: string,
    recordTarget: (target: string, preExisted: boolean) => void,
): Promise<InitCommandResult> => {
    if (options.inPlace !== true) {
        return scaffoldNewProject(options, cwd, recordTarget);
    }

    if (options.dryRun === true) {
        logWould(options.logger, `configure Lunora into ${cwd}`);

        return { code: 0, files: [], target: cwd };
    }

    return runInPlaceInit(cwd, options.logger);
};

/**
 * The post-scaffold success flow: offer the auth/email extras FIRST (they add
 * deps + bindings to package.json), then install LAST so those newly-added deps
 * are part of the single install. In-place init keeps its own per-framework
 * wiring hints and never auto-installs an existing project.
 */
const runPostScaffold = async (options: InitCommandOptions, result: InitCommandResult, cwd: string): Promise<boolean> => {
    const added = await maybeOfferExtras(options, result.target);

    const installedManager = options.inPlace === true ? undefined : await maybeOfferInstall(options, result.target);

    if (options.inPlace !== true) {
        await maybeOfferGit(options, result.target);

        // The install may have been declined; fall back to the manager detected
        // for the scaffolded project (lock file / `packageManager` field /
        // launching manager / first installed) rather than assuming pnpm.
        const manager = installedManager ?? detectPackageManager(result.target);

        // Closing flourish + next steps + Luna's send-off, after the install so it's truly last.
        await printNextSteps(basename(result.target), installedManager, manager, isInsideMonorepo(cwd));
        await emitMascot(options.logger);
    }

    return added;
};

/** `--ci`: drop a deploy pipeline into the scaffolded project (or `cwd` for in-place). Best-effort — never affects the exit code. */
const scaffoldCiPipeline = (options: InitCommandOptions, result: InitCommandResult, cwd: string): void => {
    if (result.code !== 0 || options.ci === undefined) {
        return;
    }

    if (options.dryRun === true) {
        logWould(options.logger, `scaffold a ${options.ci} CI deploy pipeline`);

        return;
    }

    const target = options.inPlace === true ? cwd : result.target;

    try {
        // Same detection the post-install summary uses, resolved fresh here
        // rather than threaded through — by this point the project's lock
        // file / `packageManager` field is written (scaffold, or the install
        // offer just above), so this is a real signal, not a guess.
        const manager = detectPackageManager(target);

        scaffoldCiWorkflow(target, options.ci, manager, options.logger);
    } catch {
        // No lock file / `packageManager` field, launching manager, or
        // installed manager to fall back on — there is nothing honest to
        // template a manager-specific pipeline with. Per `detectPackageManager`'s
        // own contract, that is a reason to skip, not to guess pnpm.
        options.logger.warn(`--ci ${options.ci}: could not detect a package manager for this project — skipped the CI pipeline.`);
    }
};

/**
 * `lunora init` entry: scaffold (in-place or a new directory), then — on success
 * — offer to add auth + email via the registry. The offer never affects the
 * scaffold's exit code.
 */
const runInitCommand = async (options: InitCommandOptions): Promise<InitCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const cleanup: ScaffoldCleanup = {};

    let result: InitCommandResult;

    try {
        result = await runScaffoldStep(options, cwd, (target, preExisted) => {
            cleanup.target = target;
            cleanup.targetPreExisted = preExisted;
        });

        if (result.code === 0 && result.target !== "") {
            // The scaffold succeeded and was announced ("Project initialized!").
            // From here a Ctrl-C in the OPTIONAL post-scaffold offers (extras /
            // install / git) must abort the offers but NOT delete the finished
            // project — so stop tracking it for cleanup. Cleanup only fires for a
            // scaffold interrupted mid-write (which throws before reaching here).
            cleanup.target = undefined;

            // An explicit `--add` that could not be applied fails the command:
            // the result used to be discarded, so a script asking for a feature
            // got an error line and exit 0.
            if (!(await runPostScaffold(options, result, cwd))) {
                result = { ...result, code: 1 };
            }
        }
    } catch (error) {
        // The user pressed Ctrl-C mid-flow — reset anything we created, then abort
        // cleanly with a friendly note (NOT the install/git failure path, which
        // prints recovery steps instead).
        if (error instanceof PromptCancelledError) {
            resetScaffoldOnCancel(cleanup, options.logger);
            process.stdout.write("\n  ✖  Setup cancelled — run `lunora init` again whenever you're ready. 🌙\n");

            return { code: 130, files: [], target: "" };
        }

        throw error;
    }

    scaffoldCiPipeline(options, result, cwd);

    return result;
};

/** Narrow a raw `--template` value to a known {@link Template}. */
const isTemplate = (value: unknown): value is Template => typeof value === "string" && TEMPLATE_IDS.includes(value);

/** Narrow the `--ci` value to a {@link CiProvider}, warning (and ignoring it) on an unknown provider. */
const resolveCiProvider = (raw: string | undefined, logger: Logger): CiProvider | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    if (isCiProvider(raw)) {
        return raw;
    }

    logger.warn(`init: unknown --ci "${raw}" — expected github | gitlab; skipping CI scaffold.`);

    return undefined;
};

/**
 * Resolve `--template` into either a bespoke template id or a create-vite
 * overlay framework, or into an error message.
 *
 * The four overlay framework names (`react` / `vue` / `solid` / `svelte`) are
 * documented `-t` values, so they route to the overlay path rather than being
 * looked up as bespoke templates that do not exist. Anything else is an ERROR:
 * silently dropping an unrecognised value (what this did) left
 * `resolveScaffoldChoice` falling through to `DEFAULT_FRAMEWORK = "react"`, so
 * `lunora init -t vue` and `lunora init -t nextjs` both scaffolded React without
 * a word — while the sibling paths (`--ci` warns, `--vite` errors) do say so.
 */
const resolveTemplateFlag = (raw: string | undefined): { error: string } | { templateType?: Template; vite?: string } => {
    if (raw === undefined) {
        return {};
    }

    if (isTemplate(raw)) {
        return { templateType: raw };
    }

    if (isOverlayFramework(raw)) {
        return { vite: raw };
    }

    return { error: `init: unknown --template "${raw}" — expected a bespoke template (${TEMPLATE_VALUES}) or an overlay framework (${OVERLAY_VALUES}).` };
};

/** `lunora init [name]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<InitOptions> = defineHandler<InitOptions>(({ argument, cwd, logger, options }) => {
    const template = resolveTemplateFlag(options.template);

    if ("error" in template) {
        logger.error(template.error);

        return { code: 1 };
    }

    return runInitCommand({
        add: options.add,
        allowUnsafeSource: options.allowUnsafeSource === true,
        cwd,
        ci: resolveCiProvider(options.ci, logger),
        dryRun: options.dryRun === true,
        from: options.from,
        inPlace: options.here === true,
        interactive: options.interactive === true ? true : undefined,
        logger,
        name: argument[0],
        ref: options.ref,
        source: options.source,
        templateType: template.templateType,
        // An explicit `--vite` still wins; `-t react` only fills the overlay slot
        // when the user did not name a framework the other way.
        vite: options.vite ?? template.vite,
        yes: options.yes === true,
    });
});

export { execute, isTemplate, resolveTemplateFlag, resolveTemplateSource };
export type { InitCommandOptions, InitCommandResult, Template };
export { runInitCommand };
