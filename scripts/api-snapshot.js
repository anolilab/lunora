/**
 * Public-API snapshot guard.
 *
 * Extracts every covered package's public API surface — export names, kinds, and
 * normalized declaration text per exports-map subpath — from the built
 * `dist/*.d.ts` entries, and pins it in committed `api-snapshots/<package>.api.md`
 * files. A breaking change to a covered surface must land together with an
 * explicit, reviewable snapshot update — it cannot ship on a reviewer's memory.
 * A source-shipping package (exports pointing at `.ts`/`.tsx` instead of a build
 * output) is extracted straight from that source instead — see `collectEntries`.
 *
 *   node scripts/api-snapshot.js check    # (default) fail if the surface drifted
 *   node scripts/api-snapshot.js update   # regenerate the snapshots
 *
 * Root scripts: `pnpm run api:check` / `pnpm run api:update`. CI runs the check
 * in the Lint workflow's `api-surface` job after `pnpm run build:packages`.
 *
 * Design notes (diff stability):
 * - Signatures are re-printed from the type AST with comments removed, so JSDoc
 *   or formatting churn in a declaration never fails the gate — only a change to
 *   the declaration itself does.
 * - `private` class members (emitted as bare `private name;` in .d.ts) are
 *   dropped — they are implementation detail, not API.
 * - Re-exports whose declarations live in ANOTHER package (sibling `@lunora/*`
 *   or third-party) are pinned by name + kind + source package only; their
 *   signature is tracked in the owning package's snapshot (siblings) or is a
 *   dependency's concern (third-party), so upstream text churn can't fail this
 *   package's gate.
 * - Exports tagged `@experimental` (JSDoc) are pinned by name + kind only and
 *   explicitly excluded from signature tracking, so the experimental tier can
 *   churn without a snapshot update. Adding/removing the tag IS a gated change.
 * - Internal `import("./packem_shared/…-<hash>.js")` specifiers inside type text
 *   are rewritten to `import("~internal")` so packem chunk-hash churn is inert.
 * - Exports are sorted by name; subpaths lexicographically with `.` first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The bare `typescript` package is the native TS7 compiler (catalog:tsc), whose root
// import lacks the classic JS API this script relies on (createProgram, createPrinter,
// printNode, SyntaxKind, …). ts-morph re-exports its own vendored classic TypeScript as
// `ts`, giving a stable, catalog-independent compiler API here.
import { ts } from "ts-morph";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const packagesDir = join(rootDir, "packages");
const snapshotsDir = join(rootDir, "api-snapshots");

/**
 * Packages covered by the guard, by DIRECTORY name (`packages/<dir>`).
 *
 * `agent`, `ai` and `platform-node` ARE covered, at TIER_3, and being covered is
 * NOT a stability promise — see {@link TIER_3}. The rest of the experimental
 * tier (`replica`, `x402`, `react-native`, `angular`, `browser`, `container`,
 * `payment`) is not covered yet.
 *
 * `platform-node` was held out entirely while it was a plan-234 spike, on the
 * grounds that its surface was still expected to move. It now implements what it
 * declares — durable alarms, scheduler, sockets and shard state, a
 * `ShardDirectory` that dispatches, `.global()` tables, workflows and object
 * storage — so it is gated, at the tier `ROADMAP.md` publishes it in. Gating it
 * is how the second host's surface stops drifting from the contracts in
 * `platform` unnoticed, which is the whole reason those two are gated; TIER_1
 * would have been a 1.0 SemVer promise this package is nowhere near making, and
 * `check-roadmap-tiers` says so at install time.
 *
 * `auth-ui` IS covered (TIER_2) despite being `private: true` with no build
 * step — privacy and "no dist" are not exemptions (see `dispatch`, also
 * private, also covered). Its `core`/`react` exports point at `.ts`/`.tsx`
 * source and are extracted via the source-file fallback in `collectEntries`.
 * Only `./core` and `./react` are wired into its exports map today; `solid`,
 * `svelte`, `vue`, `angular` aren't covered until they are.
 */
const TIER_1 = [
    "server",
    "values",
    "errors",
    "runtime",
    "do",
    "client",
    "codegen",
    "cli",
    "vite",
    "config",
    "d1",
    "react",
    "testing",
    "lunora",
    // The platform family: `platform` is contracts-only, so its surface IS the
    // product and drifting it silently is the failure this guard exists to catch.
    // `platform-cloudflare` is the reference implementation of that surface — the
    // shape a second target has to match — so it is gated the same way.
    "platform",
    "platform-cloudflare",
    "shard-engine",
    // Host-neutral observability: a second host consumes this surface directly,
    // so drifting it silently is exactly what this guard exists to catch.
    "observability",
];

const TIER_2 = [
    "vue",
    "solid",
    "svelte",
    "astro",
    "nuxt",
    "auth",
    "auth-ui",
    "storage",
    "scheduler",
    "mail",
    "notify",
    "ratelimit",
    "seed",
    "db",
    "sql-store",
    "studio",
    "advisor",
    "mcp",
    "bindings",
    "hyperdrive",
    "cloudflare-access",
    "queue",
    "workflow",
    "flags",
    "fingerprint",
    "dispatch",
];

/**
 * Experimental packages that are snapshotted anyway.
 *
 * Coverage here is EVIDENCE, not a promise. Graduating an experimental package
 * asks "has its surface settled?", and nothing could answer that while no
 * record of the surface existed — the question was decided by recollection. A
 * snapshot makes the drift visible, and the SemVer commitment still arrives
 * only at graduation.
 *
 * It costs little churn because the `@experimental` JSDoc rule above already
 * pins a tagged export by name + kind and skips its signature, and these
 * packages tag heavily. What the snapshot then tracks is the part that is NOT
 * tagged, plus every export appearing or disappearing — which is exactly the
 * settling signal.
 */
const TIER_3 = ["agent", "ai", "platform-node"];

/**
 * The tiers, each carrying the stability sentence its snapshot header ends with.
 *
 * One table rather than a label here and a matching `if` at the render site: the
 * two drifted apart trivially, and the drift failed in the WRONG DIRECTION —
 * an unrecognised label fell through to "SemVer applies", overclaiming exactly
 * the stability this file exists to police. Adding a tier now forces its
 * sentence to be written, because there is nowhere else to put it.
 *
 * `ROADMAP.md` publishes the same taxonomy in prose, and
 * `scripts/check-roadmap-tiers.js` asserts the two agree.
 */
const TIERS = [
    { dirs: TIER_1, label: "core", stability: ["here is a public-API change and must be reviewed as one (SemVer applies)."] },
    { dirs: TIER_2, label: "stable-adapter", stability: ["here is a public-API change and must be reviewed as one (SemVer applies)."] },
    {
        dirs: TIER_3,
        label: "experimental",
        stability: [
            "here is a public-API change and must be reviewed as one. This package is",
            "Experimental: the snapshot records how its surface moves, and carries NO",
            "SemVer promise until the package graduates.",
        ],
    },
];

const COVERED = TIERS.flatMap(({ dirs, label }) => dirs.map((dir) => ({ dir, tier: label })));

/** Find the `types` condition of an exports-map entry, at any nesting depth. */
const findTypesCondition = (value) => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    if (typeof value.types === "string") {
        return value.types;
    }

    for (const nested of Object.values(value)) {
        const found = findTypesCondition(nested);

        if (found) {
            return found;
        }
    }

    return undefined;
};

/** Collect `{ subpath, dts }` entries for a package from its exports map. */
const collectEntries = (pkgDir) => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const entries = [];

    if (manifest.exports && typeof manifest.exports === "object") {
        for (const [subpath, value] of Object.entries(manifest.exports)) {
            if (subpath === "./package.json") {
                continue;
            }

            const types = findTypesCondition(value);

            if (types) {
                entries.push({ dts: resolve(pkgDir, types), subpath });
            } else if (typeof value === "string" && /\.(ts|tsx)$/.test(value)) {
                // Source-shipping packages (no build step, no `dist`) point their
                // exports map straight at `.ts`/`.tsx` source — extract from that
                // directly instead of a built `.d.ts`.
                entries.push({ dts: resolve(pkgDir, value), subpath });
            }
        }
    } else if (typeof manifest.types === "string") {
        entries.push({ dts: resolve(pkgDir, manifest.types), subpath: "." });
    }

    // `.` first, then lexicographic — stable regardless of package.json order.
    entries.sort((a, b) => (a.subpath === "." ? -1 : b.subpath === "." ? 1 : a.subpath < b.subpath ? -1 : 1));

    return { entries, name: manifest.name };
};

/** Map a declaration's source file to the package that owns it. */
const owningPackage = (fileName) => {
    const normalized = fileName.split(sep).join("/");
    const nmIndex = normalized.lastIndexOf("/node_modules/");

    if (nmIndex !== -1) {
        const tail = normalized.slice(nmIndex + "/node_modules/".length);
        const segments = tail.split("/");
        const name = segments[0]?.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];

        if (name === "typescript") {
            return "typescript (lib)";
        }

        return name ?? "unknown";
    }

    const match = normalized.match(/\/packages\/([^/]+)\//);

    if (match) {
        try {
            return JSON.parse(readFileSync(join(packagesDir, match[1], "package.json"), "utf8")).name;
        } catch {
            return `packages/${match[1]}`;
        }
    }

    return "unknown";
};

const KIND_BY_SYNTAX = new Map([
    [ts.SyntaxKind.ClassDeclaration, "class"],
    [ts.SyntaxKind.EnumDeclaration, "enum"],
    [ts.SyntaxKind.ExportAssignment, "default"],
    [ts.SyntaxKind.FunctionDeclaration, "function"],
    [ts.SyntaxKind.InterfaceDeclaration, "interface"],
    [ts.SyntaxKind.ModuleDeclaration, "namespace"],
    [ts.SyntaxKind.SourceFile, "module"],
    [ts.SyntaxKind.TypeAliasDeclaration, "type"],
]);

const kindOfDeclaration = (decl) => {
    if (ts.isVariableDeclaration(decl)) {
        // eslint-disable-next-line no-bitwise
        return ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? "const" : "let";
    }

    return KIND_BY_SYNTAX.get(decl.kind) ?? "unknown";
};

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

/**
 * Normalize printed declaration text so only real signature changes diff:
 * strip `export`/`declare` prefixes, drop bare `private` members, rewrite
 * hashed internal chunk specifiers, collapse blank lines.
 */
const normalizeText = (text) => {
    const lines = text
        .replaceAll("\r\n", "\n")
        // Chunk-hash stability: import("./packem_shared/x.d-Ab12Cd34.js").T and
        // any other relative/absolute inline import point inside this package.
        .replaceAll(/import\((["'])(?:\.{1,2}\/|\/)[^"')]*\1\)/g, 'import("~internal")')
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => !/^\s*private\b[^(]*;$/.test(line));

    const collapsed = [];

    for (const line of lines) {
        if (line === "" && collapsed.at(-1) === "") {
            continue;
        }

        collapsed.push(line);
    }

    return collapsed.join("\n").trim();
};

/** Print one declaration of an exported symbol as normalized text. */
const printDeclaration = (decl) => {
    let node = decl;

    // A variable declaration alone loses its `const`/`let` keyword — print the
    // whole statement when it declares just this one variable.
    if (ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && ts.isVariableStatement(decl.parent.parent)) {
        node = decl.parent.declarations.length === 1 ? decl.parent.parent : decl.parent;
    }

    const printed = printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());

    return normalizeText(printed.replaceAll(/^export\s+/gm, "").replaceAll(/^declare\s+/gm, ""));
};

/** Render one exported symbol as a snapshot section. */
const renderExport = (checker, pkgDirName, symbol) => {
    const name = symbol.getName();
    let resolved = symbol;

    // eslint-disable-next-line no-bitwise
    if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
            resolved = checker.getAliasedSymbol(symbol);
        } catch {
            resolved = symbol;
        }
    }

    const declarations = resolved.declarations?.length ? resolved.declarations : (symbol.declarations ?? []);
    const jsDocTags = [...symbol.getJsDocTags(checker), ...(resolved === symbol ? [] : resolved.getJsDocTags(checker))];
    const experimental = jsDocTags.some((tag) => tag.name === "experimental");

    const kinds = [...new Set(declarations.map((decl) => kindOfDeclaration(decl)))].sort();
    const kind = kinds.length > 0 ? kinds.join("+") : "unknown";

    const ownPrefix = `${join(packagesDir, pkgDirName)}${sep}`;
    const foreignSources = [
        ...new Set(
            declarations.filter((decl) => !decl.getSourceFile().fileName.startsWith(ownPrefix)).map((decl) => owningPackage(decl.getSourceFile().fileName)),
        ),
    ].sort();
    const isForeign =
        declarations.length > 0 && foreignSources.length > 0 && declarations.every((decl) => !decl.getSourceFile().fileName.startsWith(ownPrefix));

    const header = `### \`${name}\` (${kind})`;

    if (experimental) {
        return `${header}\n\n_Tagged \`@experimental\` — signature not tracked; churn here does not fail the gate._`;
    }

    if (isForeign) {
        return `${header}\n\nRe-exported from ${foreignSources.map((source) => `\`${source}\``).join(", ")} — signature tracked at its source.`;
    }

    if (declarations.length === 0) {
        return `${header}\n\n_Unresolved declaration._`;
    }

    const bodies = [...new Set(declarations.map((decl) => (ts.isSourceFile(decl) ? `/* module namespace re-export */` : printDeclaration(decl))))];

    return `${header}\n\n\`\`\`ts\n${bodies.join("\n\n")}\n\`\`\``;
};

/** Render the full snapshot markdown for one covered package. */
const renderPackage = (program, checker, covered) => {
    const pkgDir = join(packagesDir, covered.dir);
    const { entries, name } = collectEntries(pkgDir);
    const sections = [];

    for (const entry of entries) {
        const sourceFile = program.getSourceFile(entry.dts);

        if (!sourceFile) {
            throw new Error(`${name}: built entry not found or not loaded: ${relative(rootDir, entry.dts)} — run \`pnpm run build:packages\` first.`);
        }

        const subpathName = entry.subpath === "." ? name : `${name}/${entry.subpath.slice(2)}`;
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        const lines = [`## \`${subpathName}\``, ""];

        if (!moduleSymbol) {
            lines.push("_No exports._");
        } else {
            const exports = checker
                .getExportsOfModule(moduleSymbol)
                .filter((exported) => !exported.getName().startsWith("__"))
                .sort((a, b) => (a.getName() < b.getName() ? -1 : 1));

            if (exports.length === 0) {
                lines.push("_No exports._");
            } else {
                lines.push(
                    ...exports
                        .map((exported) => renderExport(checker, covered.dir, exported))
                        .join("\n\n")
                        .split("\n"),
                );
            }
        }

        sections.push(lines.join("\n"));
    }

    // Spread as lines, so `header` stays one-line-per-element and the sentence
    // being shipped reads whole in the table above rather than split across a
    // variable boundary.
    const stability = TIERS.find(({ label }) => label === covered.tier).stability;

    const header = [
        `# \`${name}\` — public API`,
        "",
        `- Package: \`packages/${covered.dir}\``,
        `- Tier: ${covered.tier}`,
        "",
        "Generated by `pnpm run api:update` from the built `dist` types; verified by",
        "`pnpm run api:check` (CI: Lint / api-surface). Do not edit by hand — a diff",
        ...stability,
        "",
    ].join("\n");

    return `${header}\n${sections.join("\n\n")}\n`;
};

const snapshotFileName = (dir) => `${dir}.api.md`;

const buildAll = () => {
    const missing = [];
    const allEntries = [];

    for (const covered of COVERED) {
        const pkgDir = join(packagesDir, covered.dir);
        const { entries } = collectEntries(pkgDir);

        for (const entry of entries) {
            if (existsSync(entry.dts)) {
                allEntries.push(entry.dts);
            } else {
                missing.push(`packages/${covered.dir}: ${relative(pkgDir, entry.dts)}`);
            }
        }
    }

    if (missing.length > 0) {
        console.error("❌ Built declaration entries are missing — run `pnpm run build:packages` first:");

        for (const entry of missing) {
            console.error(`   - ${entry}`);
        }

        process.exit(1);
    }

    const program = ts.createProgram({
        options: {
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            noEmit: true,
            skipLibCheck: true,
            target: ts.ScriptTarget.ESNext,
        },
        rootNames: allEntries,
    });
    const checker = program.getTypeChecker();
    const rendered = new Map();

    for (const covered of COVERED) {
        rendered.set(snapshotFileName(covered.dir), renderPackage(program, checker, covered));
    }

    return rendered;
};

const EXPORT_MARKER_RE = /^### (`.+?` \(.+?\))$/gm;

const markerSet = (content) => new Set([...content.matchAll(EXPORT_MARKER_RE)].map((match) => match[1]));

/** Section bodies keyed by export marker, for changed-signature detection. */
const sectionsByMarker = (content) => {
    const map = new Map();
    const parts = content.split(/^### /m).slice(1);

    for (const part of parts) {
        const [head, ...body] = part.split("\n");

        map.set(head, body.join("\n").trim());
    }

    return map;
};

const printReadableDiff = (fileName, committed, current) => {
    const oldMarkers = markerSet(committed);
    const newMarkers = markerSet(current);
    const added = [...newMarkers].filter((marker) => !oldMarkers.has(marker));
    const removed = [...oldMarkers].filter((marker) => !newMarkers.has(marker));
    const oldSections = sectionsByMarker(committed);
    const newSections = sectionsByMarker(current);
    const changed = [...newMarkers].filter((marker) => oldMarkers.has(marker) && oldSections.get(marker) !== newSections.get(marker));

    for (const marker of added) {
        console.error(`   + added:   ${marker}`);
    }

    for (const marker of removed) {
        console.error(`   - removed: ${marker}`);
    }

    for (const marker of changed) {
        console.error(`   ~ changed: ${marker}`);
    }

    // Full unified diff via git for line-level detail (capped output).
    const temporaryDir = join(tmpdir(), `lunora-api-${process.pid}`);

    mkdirSync(temporaryDir, { recursive: true });

    const committedPath = join(temporaryDir, `committed-${fileName}`);
    const currentPath = join(temporaryDir, `current-${fileName}`);

    writeFileSync(committedPath, committed);
    writeFileSync(currentPath, current);

    const diff = spawnSync("git", ["diff", "--no-index", "--color=never", "--", committedPath, currentPath], { encoding: "utf8" });

    rmSync(temporaryDir, { force: true, recursive: true });

    if (diff.stdout) {
        const lines = diff.stdout.split("\n").slice(4);
        const capped = lines.slice(0, 120);

        console.error(capped.map((line) => `   ${line}`).join("\n"));

        if (lines.length > capped.length) {
            console.error(`   … (${lines.length - capped.length} more diff lines — run \`pnpm run api:update\` and inspect \`git diff api-snapshots/\`)`);
        }
    }
};

const mode = process.argv[2] ?? "check";

if (mode !== "check" && mode !== "update") {
    console.error(`Unknown mode "${mode}" — use "check" or "update".`);
    process.exit(1);
}

const rendered = buildAll();

if (mode === "update") {
    mkdirSync(snapshotsDir, { recursive: true });

    for (const [fileName, content] of rendered) {
        writeFileSync(join(snapshotsDir, fileName), content);
    }

    // Drop stale snapshots for packages no longer covered.
    for (const existing of readdirSync(snapshotsDir)) {
        if (existing.endsWith(".api.md") && !rendered.has(existing)) {
            rmSync(join(snapshotsDir, existing));
            console.log(`🗑  removed stale ${existing}`);
        }
    }

    console.log(`✅ Wrote ${rendered.size} API snapshots to api-snapshots/.`);
    process.exit(0);
}

const drifted = [];

for (const [fileName, content] of rendered) {
    const snapshotPath = join(snapshotsDir, fileName);

    if (!existsSync(snapshotPath)) {
        drifted.push(fileName);
        console.error(`❌ api-snapshots/${fileName} is missing (newly covered package?).`);
        continue;
    }

    const committed = readFileSync(snapshotPath, "utf8");

    if (committed !== content) {
        drifted.push(fileName);
        console.error(`❌ Public API drift in api-snapshots/${fileName}:`);
        printReadableDiff(fileName, committed, content);
    }
}

if (existsSync(snapshotsDir)) {
    for (const existing of readdirSync(snapshotsDir)) {
        if (existing.endsWith(".api.md") && !rendered.has(existing)) {
            drifted.push(existing);
            console.error(`❌ api-snapshots/${existing} has no covered package — remove it (pnpm run api:update).`);
        }
    }
}

if (drifted.length > 0) {
    console.error("");
    console.error(`Public API surface drifted in ${drifted.length} snapshot(s).`);
    console.error("If this change is intentional, run `pnpm run api:update` and commit the");
    console.error("snapshot diff — reviewers gate the API change through that diff.");
    process.exit(1);
}

console.log(`✅ Public API surface matches all ${rendered.size} committed snapshots.`);
