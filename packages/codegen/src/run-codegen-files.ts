/**
 * Writes the emitted `_generated/` files, and reads the project version and the sync state the writes depend on.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { readJsonSync } from "@visulima/fs";
import type { Project } from "ts-morph";

export const writeIfChanged = (filePath: string, content: string): void => {
    // Avoid spurious writes (and downstream HMR reloads) when the rendered
    // content is identical to what's on disk.
    if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf8");

        if (existing === content) {
            return;
        }
    }

    writeFileSync(filePath, content, "utf8");
};

/**
 * Write a conditionally-emitted `_generated/` file, or **delete a stale one**.
 * When `content` is the empty string (the convention `emit*` helpers use to mean
 * "not applicable") the feature is not in use, so any file left at `filePath`
 * from a prior run — when the feature WAS in use — is removed. Without this, a
 * removed feature (last container/workflow/queue deleted, `@lunora/db` /
 * `@lunora/seed` uninstalled) would leave a lingering `_generated/<feature>.ts`
 * that imports a now-absent package and breaks the build. `force: true` no-ops
 * when the file never existed. Only ever called for the known conditional set
 * (containers/workflows/queues/seed/collections and the openapi/openrpc spec
 * artifacts), so it never touches an unrelated file. Keeps the per-feature gating
 * out of `runCodegen`'s control flow.
 */
export const writeIfPresent = (filePath: string, content: string): void => {
    if (content === "") {
        rmSync(filePath, { force: true });

        return;
    }

    writeIfChanged(filePath, content);
};

/**
 * Write the RPC service declaration snapshots (`_generated/services/`, keyed
 * relative to `_generated/`) and delete any file there this run did not emit —
 * the whole folder once no RPC service is left.
 */
export const writeServiceDeclarations = (outputDirectory: string, files: Record<string, string>): void => {
    const directory = join(outputDirectory, "services");

    if (Object.keys(files).length === 0) {
        rmSync(directory, { force: true, recursive: true });

        return;
    }

    if (existsSync(directory)) {
        for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
            const path = join(entry.parentPath, entry.name);

            if (entry.isFile() && files[relative(outputDirectory, path)] === undefined) {
                rmSync(path);
            }
        }
    }

    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(outputDirectory, path)), { recursive: true });
        writeIfChanged(join(outputDirectory, path), content);
    }
};

/**
 * Read the `version` field from the `package.json` at `projectRoot`.
 *
 * Returns the version string when present and parseable, or `undefined` when
 * the manifest is absent, malformed, or carries no `version` field. The
 * `?? "0.0.0"` fallback in the spec emitters then applies, so a missing
 * package.json never breaks codegen.
 */
export const readProjectVersion = (projectRoot: string): string | undefined => {
    try {
        const manifest = readJsonSync(join(projectRoot, "package.json")) as Record<string, unknown>;

        return typeof manifest["version"] === "string" && manifest["version"] !== "" ? manifest["version"] : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Point `project`'s copy of `filePath` at `content`, without disturbing a file
 * that already matches. Absent, `createSourceFile` adds it (the cold-start
 * case). Present and identical, it is left untouched — every warm run of an
 * unchanged project, where doing nothing keeps the fully-resolved program the
 * Project was constructed with.
 *
 * Present but stale, it is rewritten IN PLACE with `replaceWithText`.
 * `createSourceFile` with the overwrite option looks equivalent and is not: it
 * swaps in a NEW SourceFile, so every already-loaded handler module still points
 * at the old, now-orphaned one and its `dataModel` type import stops resolving.
 */
export const syncProjectFile = (project: Project, filePath: string, content: string): void => {
    const existing = project.getSourceFile(filePath);

    if (existing === undefined) {
        project.createSourceFile(filePath, content, { overwrite: true });

        return;
    }

    if (existing.getFullText() === content) {
        return;
    }

    existing.replaceWithText(content);
};

/** Whether `project` already holds `filePath` with exactly `content`. */
export const projectFileMatches = (project: Project, filePath: string, content: string): boolean => project.getSourceFile(filePath)?.getFullText() === content;

/**
 * One step of the write phase, in write order. `always` writes the file. `optional`
 * writes it, or DELETES it when `content` is `""`, so a feature that is no longer in
 * use leaves no stale file behind. `services` writes the service declaration files.
 */
export type GeneratedFileStep = { content: string; kind: "always" | "optional"; name: string } | { files: Record<string, string>; kind: "services" };

/**
 * Write the `_generated/` files in the order the steps give, and return the names
 * that were written. An optional file counts only when it has content: an empty one
 * is removed, not written.
 */
export const writeGeneratedFiles = (outputDirectory: string, steps: ReadonlyArray<GeneratedFileStep>): string[] => {
    if (!existsSync(outputDirectory)) {
        mkdirSync(outputDirectory, { recursive: true });
    }

    const written: string[] = [];

    for (const step of steps) {
        if (step.kind === "services") {
            writeServiceDeclarations(outputDirectory, step.files);
            written.push(...Object.keys(step.files));
        } else if (step.kind === "always") {
            writeIfChanged(join(outputDirectory, step.name), step.content);
            written.push(step.name);
        } else {
            writeIfPresent(join(outputDirectory, step.name), step.content);

            if (step.content !== "") {
                written.push(step.name);
            }
        }
    }

    return written;
};
