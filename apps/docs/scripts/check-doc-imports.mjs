/**
 * Doc snippet API gate.
 *
 * Twoslash can't type-check the doc snippets: apps/docs doesn't depend on the
 * @lunora/* packages and the app-local `@/lunora/_generated/*` modules don't
 * exist here, so nothing resolves. This lighter check catches the two bug
 * classes that actually shipped:
 *
 *   1. importing a symbol from a package that doesn't export it (e.g.
 *      `import { query } from "@lunora/server"`, where the builders live in the
 *      generated server) — checked against the target module's real exports;
 *   2. a symbol that IS exported, used with a shape it does not have — see
 *      {@link NONEXISTENT_API}. Names alone can't see this class, and it is the
 *      worse of the two: the flagship tutorial taught `useMutation` as a
 *      callable for as long as the hook has returned an object, so a reader
 *      following it got `TypeError: send is not a function`.
 *
 * It parses every ```ts/```tsx fence across the docs and applies both.
 *
 * A deny-table, not a type checker: it holds only shapes that were WRONG in
 * shipped docs, each with the correct form in its message. Type-checking the
 * samples for real needs the packages installed here plus synthesized
 * `_generated` modules — worth doing, but not what this file is.
 *
 * Usage: node scripts/check-doc-imports.mjs   (exit 1 on any violation)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PKGS = join(ROOT, "packages");

// `blog/` is in scope for the same reason `docs/` is: its posts carry full
// runnable snippets, and two of them taught `useMutation` as a callable.
const DOC_DIRS = [join(ROOT, "apps/docs/src/content/docs"), join(ROOT, "apps/docs/src/content/blog")];
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

/**
 * Uses of a real export with a shape it does not have, as
 * `[pattern, what to write instead]`. Add an entry when a doc snippet is found
 * teaching an API the runtime never had; keep the correction in the message so
 * the failure is actionable without opening this file.
 */
const NONEXISTENT_API = [
    [
        // `const send = useMutation(fn)` then `send(args)`. The hook returns
        // `{ data, error, isError, mutate, pending, reset, withOptimisticUpdate }`.
        // A destructuring `const { mutate: send } = …` is the correct form and
        // does not match (`{` is not `\w`) — and neither does the other correct
        // form, `const m = useMutation(fn)` then `m.mutate(args)`, which is why
        // the bound name has to be seen CALLED (the backreference) rather than
        // merely bound. That is also why these run per FENCE, not per line: the
        // binding and the call are on different lines.
        /\b(?:const|let|var)\s+(\w+)\s*=\s*useMutation\([\s\S]*?\b\1\s*\(/,
        "`useMutation(fn)` returns `{ mutate, pending, … }` and is not itself callable — write `const { mutate: send } = useMutation(fn)`",
    ],
    [
        // Present on the untyped runtime writer, absent from the generated
        // typed `ctx.db`, so it may run but never type-checks in a user project.
        /\bctx\.db\.findMany\(\s*["'`]/,
        '`ctx.db.findMany("table")` is not on the generated `ctx.db` — write `ctx.db.<table>.findMany()` or `ctx.db.query("table").collect()`',
    ],
];

// The deny-table's own gate. Every entry here was added because a shipped doc
// matched it — and once that doc is fixed the pattern matches nothing, forever.
// From then on a narrowed or broken regex is indistinguishable from a clean
// repo: the run stays green either way, which is the same failure mode the
// error-catalog scanner grew a self-check for. These fixtures keep each entry
// falsifiable independently of what the docs currently say.
const SELF_CHECK = [
    // [pattern index, must match, must NOT match]
    [
        0,
        ["const send = useMutation(api.x);\nawait send(args);", "let send = useMutation(api.x);\nsend(args);", "var send = useMutation(api.x);\nsend(args);"],
        [
            "const { mutate: send } = useMutation(api.x);\nawait send(args);",
            "const { mutate } = useMutation(api.x);\nawait mutate(args);",
            // The non-destructuring form is CORRECT too — the hook's object is
            // kept and its `mutate` called off it. Flagging this blocks valid docs.
            "const m = useMutation(api.x);\nawait m.mutate(args);",
        ],
    ],
    [1, ['ctx.db.findMany("posts")', "ctx.db.findMany('posts')", "ctx.db.findMany(`posts`)"], ["ctx.db.posts.findMany()", 'ctx.db.query("posts").collect()']],
];

for (const [index, shouldMatch, shouldNotMatch] of SELF_CHECK) {
    const [pattern] = NONEXISTENT_API[index];

    for (const sample of shouldMatch) {
        if (!pattern.test(sample)) {
            console.error(
                `✗ self-check: NONEXISTENT_API[${index}] (${pattern}) no longer matches ${JSON.stringify(sample)} — the pattern was narrowed and now catches nothing.`,
            );
            process.exit(1);
        }
    }

    for (const sample of shouldNotMatch) {
        if (pattern.test(sample)) {
            console.error(
                `✗ self-check: NONEXISTENT_API[${index}] (${pattern}) matches the CORRECT form ${JSON.stringify(sample)} — it would reject valid docs.`,
            );
            process.exit(1);
        }
    }
}

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
        // A fence is the unit for NONEXISTENT_API: a misuse spans the line that
        // binds and the line that calls, so a per-line match cannot tell the
        // wrong form from the right one. Buffered here, checked when it closes.
        let fenceBody = [];
        let fenceStart = 0;

        const checkFence = () => {
            if (fenceBody.length === 0) return;

            const body = fenceBody.join("\n");

            for (const [pattern, correction] of NONEXISTENT_API) {
                const match = pattern.exec(body);

                if (match) {
                    const line = fenceStart + body.slice(0, match.index).split("\n").length;
                    violations.push(`${file.replace(ROOT, "")}:${line}  ${correction}`);
                }
            }

            fenceBody = [];
        };

        lines.forEach((line, index) => {
            const fence = line.match(/^```(\w+)/);
            if (fence) {
                checkFence();
                inTs = /^(ts|tsx|typescript)$/.test(fence[1]);
                fenceStart = index + 1;
                return;
            }
            if (line.startsWith("```")) {
                checkFence();
                inTs = false;
                return;
            }
            if (!inTs) return;

            fenceBody.push(line);

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
    console.error(`✗ ${violations.length} doc snippet violation(s):\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error("\nFix the snippet, or extend GENERATED/SUBPATH_ENTRY/NONEXISTENT_API in scripts/check-doc-imports.mjs.");
    process.exit(1);
}

console.log("✓ doc snippets check out");
