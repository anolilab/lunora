/**
 * Worker-entry auto-wiring for `lunora-container` / `lunora-workflow` — kept in
 * `_helpers/` so the tests under `tests/vis-templates/` can import it without
 * the vis runtime.
 *
 * wrangler requires every container/workflow class to be exported by the
 * deployed worker. For class-A frameworks the Vite plugin re-exports them into
 * the virtual worker; for class-B/C (a hand-written entry calling
 * `createShardDO`) the developer otherwise has to add
 * `export * from "…/_generated/<module>"` by hand — the easiest stumble. This
 * finds that entry and rewrites it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Conventional worker-entry locations probed when wrangler `main` doesn't resolve. */
const WORKER_ENTRY_FALLBACKS = ["src/server.ts", "src/server/index.ts", "src/index.ts", "src/worker.ts"];

/** Read wrangler `main` with a tolerant regex (jsonc-parser isn't resolvable from a generator). */
const readWranglerMain = (projectDirectory: string): string | undefined => {
    for (const file of ["wrangler.jsonc", "wrangler.json"]) {
        const path = join(projectDirectory, file);

        if (!existsSync(path)) {
            continue;
        }

        const match = /"main"\s*:\s*"([^"]+)"/u.exec(readFileSync(path, "utf8"));

        return match?.[1];
    }

    return undefined;
};

/** The rewritten worker entry: its project-relative path plus the new content. */
export interface WiredWorkerEntry {
    content: string;
    relativePath: string;
}

/** Which `_generated/<module>` to re-export, and the comment placed above it. */
export interface ReexportTarget {
    comment: string;
    module: string;
}

/** Default target — the container DO classes (the original behaviour). */
const CONTAINERS_TARGET: ReexportTarget = {
    comment: "// Container DO classes — wrangler requires every container class to be exported by the worker.",
    module: "containers",
};

/** WorkflowEntrypoint classes — wrangler requires every `workflows[].class_name` to be exported. */
export const WORKFLOWS_TARGET: ReexportTarget = {
    comment: "// WorkflowEntrypoint classes — wrangler requires every workflows[].class_name to be exported by the worker.",
    module: "workflows",
};

/**
 * Agent WorkflowEntrypoint classes — a `defineAgent` run IS a Cloudflare
 * Workflow instance, so (exactly like {@link WORKFLOWS_TARGET}) wrangler
 * requires every generated agent class to be exported by the deployed worker.
 */
export const AGENTS_TARGET: ReexportTarget = {
    comment: "// Agent WorkflowEntrypoint classes — wrangler requires every agent workflow class to be exported by the worker.",
    module: "agents",
};

/**
 * Find the class-B/C worker entry and return it rewritten with the
 * `_generated/<target.module>` re-export appended. Conservative: only touches a
 * file that unmistakably is a Lunora worker entry (`createShardDO(`), is
 * idempotent (skips when already wired), and returns `undefined` for class-A
 * (no such file) so the caller falls back to a printed instruction.
 */
export const wireWorkerEntryReexport = (projectDirectory: string, target: ReexportTarget = CONTAINERS_TARGET): undefined | WiredWorkerEntry => {
    const main = readWranglerMain(projectDirectory);
    const candidates = main === undefined ? WORKER_ENTRY_FALLBACKS : [main, ...WORKER_ENTRY_FALLBACKS];

    for (const candidate of candidates) {
        const absolute = join(projectDirectory, candidate);

        if (!existsSync(absolute)) {
            continue;
        }

        const source = readFileSync(absolute, "utf8");

        // A real class-B/C lunora entry only; class-A has no createShardDO file.
        if (!source.includes("createShardDO(")) {
            return undefined;
        }

        if (source.includes(`_generated/${target.module}`)) {
            return undefined; // already wired — idempotent.
        }

        const importPath = relative(dirname(absolute), join(projectDirectory, "lunora", "_generated", target.module)).replaceAll("\\", "/");
        const specifier = `${importPath.startsWith(".") ? importPath : `./${importPath}`}.js`;
        const separator = source.endsWith("\n") ? "" : "\n";

        return {
            content: `${source}${separator}\n${target.comment}\nexport * from "${specifier}";\n`,
            relativePath: candidate.replaceAll("\\", "/"),
        };
    }

    return undefined;
};

/** Build a nested vis `files` object for a (possibly deep) project-relative path. */
export const nestFile = (relativePath: string, content: string): Record<string, unknown> => {
    const segments = relativePath.split("/");
    const leaf = segments.pop() as string;

    return segments.reduceRight<Record<string, unknown>>((accumulator, segment) => ({ [segment]: accumulator }), { [leaf]: content });
};
