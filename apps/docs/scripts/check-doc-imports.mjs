/**
 * Doc snippet import gate.
 *
 * Twoslash can't type-check the doc snippets: apps/docs doesn't depend on the
 * @lunora/* packages and the app-local `@/lunora/_generated/*` modules don't
 * exist here, so nothing resolves. This lighter check catches the bug class
 * that actually shipped — importing a symbol from a package that doesn't export
 * it (e.g. `import { query } from "@lunora/server"`, where the builders live in
 * the generated server). It parses every ```ts/```tsx fence across the docs and
 * verifies each named import against the target module's real exports.
 *
 * Usage: node scripts/check-doc-imports.mjs   (exit 1 on any violation)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PKGS = join(ROOT, "packages");

const DOC_DIRS = [join(ROOT, "apps/docs/src/content/docs")];
// Package doc sources (apps/docs/src/content/docs/packages is a generated copy).
for (const pkg of readdirSync(PKGS)) {
    const d = join(PKGS, pkg, "docs");
    if (existsSync(d)) DOC_DIRS.push(d);
}

/** Known exports of the app-local generated modules (not resolvable on disk). */
const GENERATED = {
    "@/lunora/_generated/server": new Set([
        "action",
        "ActionCtx",
        "DataModel",
        "definePolicy",
        "Doc",
        "Id",
        "internalAction",
        "internalMutation",
        "internalQuery",
        "mutation",
        "MutationCtx",
        "query",
        // common type-only exports
        "QueryCtx",
        "v",
    ]),
    // `agents` / `workflows` are the typed scheduler-target reference objects
    // codegen emits alongside `api` / `internal` when the project declares them.
    "@/lunora/_generated/api": new Set(["agents", "api", "FunctionReference", "internal", "workflows"]),
};

// Umbrella `lunorash/<sub>` re-exports the base packages.
const UMBRELLA = new Set(["client", "do", "runtime", "server", "values"]);

// Subpath → source entry file (relative to a package's src/). The `@lunora/payment` provider
// adapters ship as per-provider subpaths (`@lunora/payment/stripe`, …) mapping to `src/providers/*`.
const SUBPATH_ENTRY = {
    "": "index",
    autumn: "providers/autumn",
    "autumn-features": "providers/autumn-features",
    bridge: "bridge",
    client: "client",
    creem: "providers/creem",
    do: "do",
    dodopayments: "providers/dodopayments",
    plugins: "plugins",
    polar: "providers/polar",
    server: "server",
    stripe: "providers/stripe",
    testing: "testing",
    worker: "worker",
};

/**
 * Collect exported names from a TS source file. Returns null if it can't be
 *  validated confidently (missing file, or `export *` makes the set open).
 * @param srcFile
 */
function exportsOf(srcFile) {
    if (!existsSync(srcFile)) return null;

    const text = readFileSync(srcFile, "utf8");
    if (/^\s*export\s+\*\s+from/m.test(text)) return null; // open re-export, skip

    const names = new Set();
    // export { a, type b, c as d }  /  export type { ... }
    for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
        for (const part of m[1].split(",")) {
            const name = part
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/)
                .pop()
                ?.trim();
            if (name) names.add(name);
        }
    }
    // export const/function/class/type/interface/enum NAME
    for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|type|interface|enum)\s+([\w$]+)/g)) {
        names.add(m[1]);
    }
    return names;
}

/**
 * Resolve a module specifier to its allowed export names, or null to skip.
 * @param spec
 */
function allowedExports(spec) {
    if (GENERATED[spec]) return GENERATED[spec];

    let scopedPkg;
    let subpath = "";
    if (spec === "lunorash" || spec.startsWith("lunorash/")) {
        const sub = spec.slice("lunorash".length).replace(/^\//, "");
        if (!UMBRELLA.has(sub)) return null; // unknown umbrella subpath
        scopedPkg = sub;
    } else if (spec.startsWith("@lunora/")) {
        const rest = spec.slice("@lunora/".length);
        const [pkg, ...subs] = rest.split("/");
        scopedPkg = pkg;
        subpath = subs.join("/");
    } else {
        return null; // third-party / unmappable
    }

    const entry = SUBPATH_ENTRY[subpath];
    if (entry === undefined) return null; // unmapped subpath → don't flag
    return exportsOf(join(PKGS, scopedPkg, "src", `${entry}.ts`));
}

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (name.endsWith(".mdx")) yield p;
    }
}

const violations = [];

for (const dir of DOC_DIRS) {
    for (const file of walk(dir)) {
        const lines = readFileSync(file, "utf8").split("\n");
        let inTs = false;
        lines.forEach((line, index) => {
            const fence = line.match(/^```(\w+)/);
            if (fence) {
                inTs = /^(ts|tsx|typescript)$/.test(fence[1]);
                return;
            }
            if (line.startsWith("```")) {
                inTs = false;
                return;
            }
            if (!inTs) return;

            const imp = line.match(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/);
            if (!imp) return;

            const allowed = allowedExports(imp[2]);
            if (!allowed) return; // unvalidatable specifier

            for (const part of imp[1].split(",")) {
                // strip an inline `type` modifier and any `as` alias
                const name = part
                    .trim()
                    .replace(/^type\s+/, "")
                    .split(/\s+as\s+/)[0]
                    ?.trim();
                if (name && !allowed.has(name)) {
                    violations.push(`${file.replace(ROOT, "")}:${index + 1}  "${name}" is not exported by "${imp[2]}"`);
                }
            }
        });
    }
}

if (violations.length > 0) {
    console.error(`✗ ${violations.length} doc import violation(s):\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error("\nFix the import, or extend GENERATED/SUBPATH_ENTRY in scripts/check-doc-imports.mjs.");
    process.exit(1);
}

console.log("✓ doc snippet imports check out");
