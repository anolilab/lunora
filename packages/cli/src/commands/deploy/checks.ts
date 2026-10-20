/**
 * The read-only pre-deploy checks `lunora deploy` and `lunora prepare` share:
 * Docker and container sources, the D1 placeholder, localhost origins in vars,
 * and the `--migrate` preflight — plus deploy's open-shard-access gate.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { AdvisorOpenShardAccess } from "@lunora/advisor";
import { openShardAccess, runAdvisor } from "@lunora/advisor";
import { isTestPath, PROJECT_CONFIG_FILENAMES } from "@lunora/codegen";
import type { DiscoveryCache } from "@lunora/config";
import { COMPOSED_WORKER_ENTRY, discoverContainerInfo, resolveSchemaDirectory } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";
import { dirname, join, relative } from "@visulima/path";
import type { BinaryExpression, ElementAccessExpression } from "ts-morph";
import { Node, Project, SyntaxKind } from "ts-morph";

import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { ExitCode } from "../../util/exit-code";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { DeployCommandOptions } from "./types";

/** Placeholder written by `reconcileWranglerBindings` for auto-provisioned D1 bindings. */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

interface WranglerD1Entry {
    binding?: string;
    database_id?: string;
}

interface WranglerD1Shape {
    containers?: ReadonlyArray<{ image?: string } | null | undefined>;
    d1_databases?: ReadonlyArray<WranglerD1Entry>;
    vars?: Record<string, unknown>;
}

/**
 * Normalise a raw binding array read out of hand-written JSONC: `undefined`
 * when it is not an array at all, otherwise the array with its nullish entries
 * dropped.
 *
 * `"d1_databases": [null]` passes an `Array.isArray` check, and the placeholder
 * gate below then dereferenced `entry.database_id` and threw a TypeError out of
 * a preflight — before `validateWrangler` got to report the malformed config
 * the user can actually act on. A malformed shape is the validator's error to
 * report, never a stack trace out of a gate, so the entries are dropped once
 * here rather than guarded at each reader.
 */
const bindingEntries = (value: unknown): unknown[] | undefined =>
    Array.isArray(value) ? (value as unknown[]).filter((entry) => entry !== null && entry !== undefined) : undefined;

/**
 * Find and parse the project's wrangler.jsonc **in the `--env` view wrangler
 * will deploy**; `undefined` when absent or unparseable.
 *
 * `vars`, `d1_databases` and `containers` are all non-inheritable in wrangler,
 * so `deploy --env staging` uses `env.staging`'s values and ignores the top
 * level entirely. Reading the top level here shipped an env-scoped placeholder
 * database_id / loopback origin silently, and falsely blocked the reverse
 * layout (dev values at the top, real ones in the env block). Shares
 * `mergeWranglerEnvironment` with the validator so both agree with wrangler.
 */
const readWranglerShape = (cwd: string, environment?: string): WranglerD1Shape | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (parsed === undefined) {
        return undefined;
    }

    // An undeclared `--env` is the validator's error to report (it never reaches
    // the wrangler spawn), so fall back to the unmerged view rather than
    // duplicating that message from a preflight.
    const { error, merged } = mergeWranglerEnvironment(parsed, environment);
    // Read back as `unknown`: `WranglerConfig` describes a WELL-FORMED config,
    // but this is hand-written JSONC where `"d1_databases": {}` type-checks as
    // an array and then throws `.filter is not a function` inside a preflight.
    // Normalised once here rather than at each gate — a malformed shape is the
    // validator's error to report, never a stack trace out of a gate.
    const view = (error === undefined ? merged : parsed) as Record<string, unknown>;
    const { containers, d1_databases: databases, vars } = view;

    return {
        containers: bindingEntries(containers) as WranglerD1Shape["containers"],
        d1_databases: bindingEntries(databases) as WranglerD1Shape["d1_databases"],
        vars: typeof vars === "object" && vars !== null && !Array.isArray(vars) ? (vars as Record<string, unknown>) : undefined,
    };
};

/**
 * Every IPv4 loopback address, not just `127.0.0.1`: the whole `127.0.0.0/8`
 * block is loopback (RFC 1122), so `127.0.0.2` is exactly as unreachable from a
 * deployed Worker. Matched as a dotted quad rather than a `"127."` prefix,
 * because `127.example.com` is a routable DNS name and must not be blocked.
 *
 * The shorter numeric spellings need no pattern of their own — `new URL()`
 * canonicalises them for http(s), so `127.1`, `0x7f.1` and `2130706433` all
 * arrive here as `127.0.0.1`.
 */
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

/** True when a URL string resolves to a loopback host (localhost / 127.0.0.0/8 / ::1). */
const isLocalhostUrl = (value: string): boolean => {
    try {
        const { hostname } = new URL(value);

        return hostname === "localhost" || IPV4_LOOPBACK.test(hostname) || hostname === "::1" || hostname === "[::1]";
    } catch {
        return false;
    }
};

/** Mirrors the validator's heuristic: a container image that is a local path (vs a registry reference). */
const isLocalImagePath = (image: string): boolean => image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile");

/**
 * `wrangler deploy` builds and pushes a container image with the local Docker
 * engine whenever `containers[].image` points at a Dockerfile. Check that
 * prerequisite up front and return an actionable error instead of letting
 * wrangler fail mid-deploy with an opaque engine error. Returns `undefined`
 * when no local image build is needed or Docker is available.
 */
const checkContainerDockerPreflight = (
    cwd: string,
    logger: Logger,
    dockerAvailable: DockerProbe,
    command: PreDeployCommand = "deploy",
    environment?: string,
): string | undefined => {
    const localImages = (readWranglerShape(cwd, environment)?.containers ?? []).filter(
        (entry) => typeof entry?.image === "string" && isLocalImagePath(entry.image),
    );

    if (localImages.length === 0 || dockerAvailable()) {
        return undefined;
    }

    const message =
        `${command} blocked: wrangler.jsonc declares ${String(localImages.length)} container(s) built from a local Dockerfile, but no Docker-compatible ` +
        `engine is available. Start Docker (or Colima), or point the container's \`image\` at a pre-built registry reference. ` +
        `Note: container images must target linux/amd64.`;

    logger.error(message);

    return message;
};

/**
 * Resolve the worker entry `wrangler deploy` should bundle. Class-B frameworks
 * (SvelteKit, Astro) ship a CF adapter that owns the wrangler `main` field and
 * overwrites it with its own generated worker at build time — so `main` cannot
 * itself point at Lunora's composition. The template instead ships a
 * composed entry that imports that generated handler, wraps it with
 * `withLunora` (mounting `/_lunora/*`), and re-exports `ShardDO`. When that file
 * exists we pass it as the positional deploy entry so the ONE deployed worker is
 * the composed one — the positional argument overrides `main`. Class-A/C
 * templates have no composed entry (their `main` already points at the real
 * entry), so this returns `undefined` and `wrangler` uses `main` as usual.
 *
 * The path is {@link COMPOSED_WORKER_ENTRY}, imported rather than repeated:
 * `inferLunoraBindings` probes the same file to decide which classes are
 * provisioned, and a literal in each place is a divergence waiting to happen.
 */
const resolveComposedWorkerEntry = (cwd: string): string | undefined => (existsSync(join(cwd, COMPOSED_WORKER_ENTRY)) ? COMPOSED_WORKER_ENTRY : undefined);

/**
 * Verify every container's local build source exists before wrangler/railpack
 * runs. A Dockerfile/build-dir typo otherwise fails opaquely mid-deploy.
 * Registry images have no local source, so they're skipped. Returns the first
 * error message, or `undefined` when all sources exist (or none are local).
 */
const checkContainerSourcesExist = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", cache?: DiscoveryCache): string | undefined => {
    for (const container of discoverContainerInfo(cwd, "lunora", cache).containers) {
        const image = container.schedulingPolicy === undefined ? container.image : undefined;
        // A `durable_object` container's local sources are its named images.
        const dockerfiles = [
            ...(image?.kind === "dockerfile" ? [{ field: "image", path: image.dockerfilePath }] : []),
            ...Object.entries(container.schedulingPolicy === "durable_object" ? (container.images ?? {}) : {}).flatMap(([name, named]) =>
                named.kind === "dockerfile" ? [{ field: `images["${name}"]`, path: named.dockerfilePath }] : [],
            ),
        ];
        const missing = dockerfiles.find((dockerfile) => !existsSync(join(cwd, dockerfile.path)));

        if (missing !== undefined) {
            const message = `${command} blocked: container "${container.exportName}" references a Dockerfile at "${missing.path}" that does not exist. Create it or fix the \`${missing.field}\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }

        if (image?.kind === "build" && !existsSync(join(cwd, image.buildDir))) {
            const message = `${command} blocked: container "${container.exportName}" references a Railpack build directory "${image.buildDir}" that does not exist. Create it or fix the \`image.build\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }
    }

    return undefined;
};

/**
 * Return the name of any D1 binding that still carries the placeholder
 * database_id written by `reconcileWranglerBindings`. Returns `undefined`
 * when no placeholder is found (or when wrangler.jsonc is absent/unparseable —
 * the validator will report the real problem in that case).
 */
const findD1PlaceholderBinding = (cwd: string, environment?: string): string | undefined =>
    (readWranglerShape(cwd, environment)?.d1_databases ?? []).find((entry) => entry.database_id === D1_PLACEHOLDER_ID)?.binding;

/**
 * Validate the migration options that would otherwise fail only after the live
 * worker has already been replaced by `wrangler deploy`.
 */
const validateMigrateDeployPreflight = (options: DeployCommandOptions): string | undefined => {
    // A dry run / preview never publishes a live version, so post-deploy
    // migrations don't run — don't demand `--migrate-url`/`--migrate-yes` for a
    // `--dry-run --migrate` or `--preview --migrate` combo.
    if (!options.migrate || options.dryRun || options.preview) {
        return undefined;
    }

    // The deployed URL is only known AFTER wrangler runs, and this gate runs
    // before it — so there is nothing to default to here, and without an
    // explicit `--migrate-url` the downstream migration would fall back to
    // `http://localhost:8787` (the dev worker) and apply against LOCAL state —
    // and ship the production admin bearer to whatever listens on that port.
    // Refuse before deploying rather than silently targeting localhost later.
    // (A linked checkout satisfies this without the flag: the caller resolves
    // `migrateUrl` through `resolveWorkerUrl`, which reads the link this
    // deploy's predecessor recorded.)
    if (options.migrateUrl === undefined) {
        const message =
            "--migrate requires --migrate-url <https://your-worker> — the deploy target URL is only known after wrangler runs, and this gate runs before it; refusing to default to localhost";

        options.logger.error(message);

        return message;
    }

    if (options.migrateYes !== true) {
        const message = "--migrate runs production data migrations after deploy. Re-run with --migrate-yes to confirm.";

        options.logger.error(message);

        return message;
    }

    const migrateToken = options.migrateToken ?? process.env.LUNORA_ADMIN_TOKEN;

    if (migrateToken === undefined || migrateToken === "") {
        const message = "admin token required for --migrate — pass --migrate-token or set LUNORA_ADMIN_TOKEN";

        options.logger.error(message);

        return message;
    }

    return undefined;
};

/**
 * Check for a D1 placeholder database_id and return an error message when one
 * is found. Returns `undefined` when the config is clean (or absent/unparseable
 * — those cases fall through to the validator). Extracted from `runDeployCommand`
 * to keep its cognitive complexity within the 15-node budget.
 */
const checkD1Placeholder = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const placeholderBinding = findD1PlaceholderBinding(cwd, environment);

    if (placeholderBinding === undefined) {
        return undefined;
    }

    const message =
        `${command} blocked: the "${placeholderBinding}" D1 binding has a placeholder database_id ` +
        `("${D1_PLACEHOLDER_ID}"). Run \`wrangler d1 create <name>\` to create the database, ` +
        `then replace the placeholder in wrangler.jsonc with the real id before deploying.`;

    logger.error(message);

    return message;
};

/**
 * Hard-block a deploy when a worker-origin `var` still points at localhost.
 * `lunora deploy` always targets Cloudflare (the dev loop is `lunora dev`), and
 * a Worker can't reach a loopback address — so a localhost origin silently
 * breaks scheduled jobs / auth callbacks in production. Mirrors the
 * D1-placeholder hard-block. Returns the error message, or `undefined` when
 * clean (or when wrangler.jsonc is absent/unparseable — the validator handles
 * that).
 *
 * Checks every `var`, not a named subset — see the filter below.
 */
const checkLocalhostOriginVariables = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const variables = readWranglerShape(cwd, environment)?.vars;

    if (!variables) {
        return undefined;
    }

    // Every `var` whose value is a loopback URL, not a list of known names: the
    // invariant is a property of the VALUE (a deployed Worker cannot reach
    // loopback, whatever the var is called), and the allowlist this replaces had
    // already gone stale — it covered `LUNORA_ORIGIN_URL` and `AUTH_URL` while
    // `APP_BASE_URL` and `PUBLIC_STORAGE_BASE_URL` shipped localhost defaults
    // past it. A name list has to be extended by whoever adds the next origin
    // var, which is exactly the person who doesn't know this gate exists.
    const offenders = Object.entries(variables)
        .filter(([, value]) => typeof value === "string" && isLocalhostUrl(value))
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b));

    if (offenders.length === 0) {
        return undefined;
    }

    const message =
        `${command} blocked: ${offenders.join(", ")} in wrangler.jsonc point at localhost. A deployed Worker can't reach a loopback ` +
        `address, so this silently breaks scheduled-job dispatch, reverse cross-shard relations, and auth callbacks. ` +
        `Set each to the deployed worker's public URL ` +
        `(or move it to a secret with \`wrangler secret put\`) before deploying.`;

    logger.error(message);

    return message;
};

/**
 * The commands that run the pre-deploy pipeline, as the OPERATOR typed them.
 *
 * These checks are reached from `lunora deploy`, `lunora prepare` and
 * `lunora build`, and a blocked run naming a command the operator never ran
 * reads as a bug in the tool rather than a problem in the project.
 *
 * `build` is one of them: it delegates to `runDeployCommand({ dryRun: true })`.
 * The name is threaded through rather than assumed, because the drift gate uses
 * it for two operator-facing decisions — which override flags to offer, and what
 * to call the thing that was blocked. Hardcoding `"deploy"` here meant `lunora
 * build` reported "deploy blocked" for a deploy nobody attempted and recommended
 * a flag `build` rejects with a raw stack trace.
 */
type PreDeployCommand = "build" | "deploy" | "prepare";

/** Root files an app configures itself in: the Vite config (the class-A opt-in) and `lunora.config.*` (its `app` hook). */
const OPEN_SHARD_SCAN_ROOT_FILES = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    ...PROJECT_CONFIG_FILENAMES,
];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
/** Test files in every source extension; `isTestPath` covers the `.ts`/`.tsx` ones and the test folders. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const OPEN_SHARD_OPTION = "allowUnauthenticatedShardAccess";
const PATH_SEPARATOR = /[\\/]/u;
/** Build output and installed code: a bundle that inlines the runtime is not app source, so its options are not read. */
const NON_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set(["_generated", "build", "dist", "node_modules"]);

/**
 * Whether a resolved module is app source: a source extension, not a test file, and
 * no segment that is build output, installed code, or a dot-folder such as
 * `.svelte-kit` or `.open-next`. A bundle the config imports carries the runtime
 * inlined, so reading it would report options the app does not set.
 */
const isAppSourceModule = (cwd: string, file: string): boolean => {
    const segments = relative(cwd, file).split(PATH_SEPARATOR);

    return (
        SOURCE_FILE.test(file) &&
        !TEST_FILE.test(file) &&
        !isTestPath(segments.join("/")) &&
        segments.every((segment) => segment === ".." || (!segment.startsWith(".") && !NON_SOURCE_DIRECTORIES.has(segment)))
    );
};

/**
 * The Wrangler `main` entrypoint of the environment being deployed, which can sit outside `src/`
 * (the Analog template deploys a root `worker.ts`). An environment may override `main`, so the
 * merged view is read; an undeclared `--env` falls back to the top level, which the validator reports.
 */
const wranglerMainEntry = (cwd: string, environment?: string): string[] => {
    const wranglerPath = findWranglerFile(cwd);

    if (wranglerPath === undefined) {
        return [];
    }

    const { parsed } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (parsed === undefined) {
        return [];
    }

    const { error, merged } = mergeWranglerEnvironment(parsed, environment);
    const { main } = error === undefined ? merged : parsed;
    // Wrangler resolves `main` against its own config file, not the project root.
    const entry = typeof main === "string" ? join(dirname(wranglerPath), main) : undefined;

    return entry !== undefined && existsSync(entry) && isAppSourceModule(cwd, entry) ? [entry] : [];
};

/** The literal `false`, under any parentheses, `as`, `satisfies`, `<T>` or `!` wrapper (`false as const` is still false). */
const isLiteralFalse = (node: Node | undefined): boolean => {
    if (node === undefined) {
        return false;
    }

    if (node.getKind() === SyntaxKind.FalseKeyword) {
        return true;
    }

    return Node.isParenthesizedExpression(node) ||
        Node.isAsExpression(node) ||
        Node.isSatisfiesExpression(node) ||
        Node.isTypeAssertion(node) ||
        Node.isNonNullExpression(node)
        ? isLiteralFalse(node.getExpression())
        : false;
};

/** A path's stats, following links. A broken or self-referential link has none: `statSync` throws, and the entry is skipped. */
const statEntry = (path: string): ReturnType<typeof statSync> | undefined => {
    try {
        return statSync(path);
    } catch {
        return undefined;
    }
};

/**
 * The source files under `directory` that can carry app options, walked the way
 * codegen walks them: symlinks followed, one visit per real directory, and test
 * and generated folders pruned before descent. Paths are `/`-separated relative
 * to `root`, so `isTestPath` sees the same shape on Windows.
 */
const appSourceFiles = (root: string, directory: string, visited = new Set<string>()): string[] => {
    let realDirectory: string;

    try {
        realDirectory = realpathSync(directory);
    } catch {
        return [];
    }

    if (visited.has(realDirectory)) {
        return [];
    }

    visited.add(realDirectory);

    return readdirSync(directory).flatMap((entry) => {
        const full = join(directory, entry);
        const info = statEntry(full);

        if (info === undefined) {
            return [];
        }

        const relativePath = relative(root, full).split(sep).join("/");

        if (info.isDirectory()) {
            // Build output and dot-folders (`.svelte-kit`, `.open-next`) are not walked, the same rule as the imported modules: a bundle carries the runtime inlined.
            const skipped = NON_SOURCE_DIRECTORIES.has(entry) || entry.startsWith(".") || isTestPath(`${relativePath}/`);

            return skipped ? [] : appSourceFiles(root, full, visited);
        }

        return info.isFile() && SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !isTestPath(relativePath) ? [full] : [];
    });
};

/** The key a member is written under: a string literal's value, a literal computed key's value, otherwise its source text. */
const memberKeyName = (nameNode: Node): string => {
    const keyNode = Node.isComputedPropertyName(nameNode) ? nameNode.getExpression() : nameNode;

    return Node.isStringLiteral(keyNode) || Node.isNoSubstitutionTemplateLiteral(keyNode) ? keyNode.getLiteralValue() : nameNode.getText();
};

/** Extensions a relative import can resolve to, as the bundler tries them. */
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** The JavaScript extension a TypeScript ESM import writes for its `.ts` source. */
const JS_EXTENSION = /\.(?:[cm]?js|jsx)$/u;

/**
 * The file a relative import names, or `undefined` for a bare specifier or a
 * file that does not exist. Tries the name as written, then with each source
 * extension, then as a directory's index. A `.js` specifier also maps to its
 * `.ts` source, which is how TypeScript ESM code writes imports.
 */
const resolveRelativeImport = (fromFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) {
        return undefined;
    }

    const base = resolve(dirname(fromFile), specifier);
    const withoutJsExtension = base.replace(JS_EXTENSION, "");
    const candidates = [
        base,
        ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...IMPORT_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
        ...IMPORT_EXTENSIONS.map((extension) => `${withoutJsExtension}${extension}`),
    ];

    return candidates.find((candidate) => statEntry(candidate)?.isFile() === true);
};

/**
 * The local modules the app's configuration and Wrangler entrypoint import, followed
 * through their own imports. An open-shard option kept in a module beside the
 * config reaches the worker through it, so the module is read as well.
 */
const importedModules = (roots: string[], project: Project, cwd: string): string[] => {
    const seen = new Set(roots);
    const queue = [...roots];
    const found: string[] = [];

    for (let index = 0; index < queue.length; index += 1) {
        const file = queue[index] ?? "";
        const source = project.createSourceFile(relative(cwd, file), readFileSync(file, "utf8"), { overwrite: true });
        const specifiers = [...source.getImportDeclarations(), ...source.getExportDeclarations()]
            .map((declaration) => declaration.getModuleSpecifierValue())
            .filter((specifier): specifier is string => specifier !== undefined);

        for (const specifier of specifiers) {
            const resolved = resolveRelativeImport(file, specifier);

            if (resolved !== undefined && isAppSourceModule(cwd, resolved) && !seen.has(resolved)) {
                seen.add(resolved);
                found.push(resolved);
                queue.push(resolved);
            }
        }
    }

    return found;
};

/** The literal bracket key of an element access (`x["name"]`), or `undefined` for any other key. */
const literalElementKey = (access: ElementAccessExpression): string | undefined => {
    const key = access.getArgumentExpression();

    return key !== undefined && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) ? key.getLiteralValue() : undefined;
};

/** The key an assignment target writes, when it is a dot access or a literal bracket access. */
const assignedKey = (target: Node): string | undefined => {
    if (Node.isPropertyAccessExpression(target)) {
        return target.getName();
    }

    return Node.isElementAccessExpression(target) ? literalElementKey(target) : undefined;
};

/** Whether `expression` assigns something other than a literal `false` to the open-shard option, by dot or literal bracket key. */
const isOpenShardAssignment = (expression: BinaryExpression): boolean => {
    if (expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        return false;
    }

    return assignedKey(expression.getLeft()) === OPEN_SHARD_OPTION && !isLiteralFalse(expression.getRight());
};

/**
 * Every open-shard member in the app that is not a literal `false`.
 *
 * Read with the TypeScript parser, not a text match, so the "before deploying"
 * comments the templates keep beside the flag never count. Files that do not
 * mention the name are skipped before parsing. Fails closed: a value the scan
 * cannot read (a variable, a shorthand, a getter) is reported, because the runtime
 * evaluates it. Ceiling, not covered: a computed key built from a variable, an
 * `Object.assign` or a spread from a variable, and any file outside `schemaDir`,
 * `src/`, the root Vite config, `lunora.config.*` and the Wrangler `main` of the
 * environment being deployed, and any module those import only through a bare
 * specifier, a path alias or a dynamic `import()`. Build and dist folders and
 * dot-folders are not read at all: a bundle inlines the runtime, so an
 * app-authored module kept under such a name is not seen either. Rename the
 * folder, or pass `--allow-open-shards`, if that matters.
 */
const findOpenShardAccess = (cwd: string, environment?: string): AdvisorOpenShardAccess[] => {
    const directories = [...new Set([resolveSchemaDirectory(cwd), "src"])].filter((directory) => existsSync(join(cwd, directory)));
    const roots = [...OPEN_SHARD_SCAN_ROOT_FILES.map((file) => join(cwd, file)).filter((file) => existsSync(file)), ...wranglerMainEntry(cwd, environment)];
    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const files = [
        ...new Set([
            ...directories.flatMap((directory) => appSourceFiles(join(cwd, directory), join(cwd, directory))),
            ...roots,
            ...importedModules(roots, project, cwd),
        ]),
    ];

    return files.flatMap((file) => {
        const text = readFileSync(file, "utf8");

        if (!text.includes(OPEN_SHARD_OPTION)) {
            return [];
        }

        const source = project.createSourceFile(relative(cwd, file), text, { overwrite: true });

        const members = [
            ...source.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
            ...source.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment),
            ...source.getDescendantsOfKind(SyntaxKind.GetAccessor),
            ...source.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
        ]
            .filter((member) => {
                // Only a literal `false` is safe. A shorthand, getter or method has no literal to read, so it is reported too.
                const isSafe = Node.isPropertyAssignment(member) && isLiteralFalse(member.getInitializer());

                return memberKeyName(member.getNameNode()) === OPEN_SHARD_OPTION && !isSafe;
            })
            .map((member) => member.getStartLineNumber());
        // An assignment to the option (`options.name = …`, `options["name"] = …`) sets it on an object the runtime reads, so it counts too.
        const assignments = source
            .getDescendantsOfKind(SyntaxKind.BinaryExpression)
            .filter((expression) => isOpenShardAssignment(expression))
            .map((expression) => expression.getStartLineNumber());

        return [...members, ...assignments].map((line) => {
            return { file: relative(cwd, file), line };
        });
    });
};

/**
 * Refuse a deploy that ships the open-shard option set to anything but a literal `false` — the
 * `open_shard_access` advisor lint — unless `--allow-open-shards` says the open
 * posture is deliberate. Every template carries the flag for its local demo, and
 * the runtime only logs a warning about it, so without this a first deploy goes
 * out with any caller able to read any shard.
 *
 * Deploy only: `build` and `prepare` produce or check an artifact, they do not
 * publish one, and the template build matrix runs `lunora build` on every
 * template as shipped. Returns the error message, or `undefined` when clean.
 */
const checkOpenShardAccess = (cwd: string, logger: Logger, command: PreDeployCommand, allowOpenShards: boolean, environment?: string): string | undefined => {
    if (command !== "deploy") {
        return undefined;
    }

    const findings = runAdvisor({ openShardAccess: findOpenShardAccess(cwd, environment), schema: { tables: [] } }, { lints: [openShardAccess] });

    if (findings.length === 0) {
        return undefined;
    }

    const sites = findings.map((finding) => `${String(finding.metadata["file"])}:${String(finding.metadata["line"])}`).join(", ");

    if (allowOpenShards) {
        logger.warn(`deploying with open shard access (--allow-open-shards): ${sites}`);

        return undefined;
    }

    const message = `deploy blocked (open_shard_access): ${sites} enable the open-shard option (any value but a literal false), so any caller may target any shard. ${openShardAccess.remediation}`;

    logger.error(message);

    return message;
};

/**
 * The read-only half of the pre-deploy gates: deploy's open-shard-access gate,
 * the D1-placeholder hard-block, the localhost-origin var check, and the
 * container source + Docker preflights.
 * Returns the first error message, or `undefined` when all pass.
 *
 * Separate from the container BUILD so `lunora prepare` can run the checks
 * without it: building pushes images, which a command whose whole job is "tell me
 * whether this would deploy" must not do. `executeDeploy` runs both.
 */
const runPreDeployChecks = (cwd: string, options: DeployCommandOptions, command: PreDeployCommand): { code: ExitCode; error: string } | undefined => {
    const openShardError = checkOpenShardAccess(cwd, options.logger, command, options.allowOpenShards === true, options.env);

    if (openShardError !== undefined) {
        return { code: EXIT_CODE.USAGE, error: openShardError };
    }

    const d1Error = checkD1Placeholder(cwd, options.logger, command, options.env);

    if (d1Error !== undefined) {
        return { code: EXIT_CODE.USAGE, error: d1Error };
    }

    const localhostOriginError = checkLocalhostOriginVariables(cwd, options.logger, command, options.env);

    if (localhostOriginError !== undefined) {
        return { code: EXIT_CODE.USAGE, error: localhostOriginError };
    }

    const sourceError = checkContainerSourcesExist(cwd, options.logger, command, options.discoveryCache);

    if (sourceError !== undefined) {
        return { code: EXIT_CODE.USAGE, error: sourceError };
    }

    const dockerError = checkContainerDockerPreflight(cwd, options.logger, options.dockerAvailable ?? isDockerAvailable, command, options.env);

    // Not a usage error: the project is fine and the machine is not. Same bucket
    // `lunora cloudflare containers build` already exits with for the same missing engine.
    return dockerError === undefined ? undefined : { code: EXIT_CODE.MISSING_DEPENDENCY, error: dockerError };
};

export type { PreDeployCommand };
export { resolveComposedWorkerEntry, runPreDeployChecks, validateMigrateDeployPreflight };
