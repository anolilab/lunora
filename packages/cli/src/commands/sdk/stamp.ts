/**
 * The stamp is the record of what a `sdk generate` run wrote, and regeneration
 * trusts it to decide what to delete. A file is only ever removed when a stamp
 * of the current format lists it, so a missing, older or garbled stamp means
 * nothing is pruned — the cost of a stale file is far lower than the cost of
 * deleting something the user wrote.
 */

import type { Stats } from "node:fs";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { resolveCliVersion } from "../../util/cli-manifest";

/** The sidecar recording which transport vintage the output holds, and what it wrote. */
const STAMP_FILE = "lunora-transport.json";

/**
 * Bumped whenever the stamp's shape changes. A reader that finds any other value
 * treats the stamp as absent, which is what makes an older run's stamp safe.
 */
const STAMP_FORMAT = 2;

/** What a completed vendoring recorded. */
interface VendorResult {
    /** The ref the transport actually came from. */
    ref: string;
    /** Where it came from: the giget base, or the local `--from` directory. */
    source: string;
    /** Paths the transport wrote, relative to the output directory, sorted. */
    transportFiles: ReadonlyArray<string>;
    /** True when the ref above is the running CLI's own release tag. */
    versionMatched: boolean;
}

/** The two lists a stamp carries. Both are relative to the output directory. */
interface StampFiles {
    /** Files the generator emitted. */
    generatedFiles: ReadonlyArray<string>;
    /** Files the vendored transport contributed. */
    transportFiles: ReadonlyArray<string>;
}

interface PruneResult {
    deleted: string[];
    refused: { path: string; reason: string }[];
}

const byPath = (a: string, b: string): number => a.localeCompare(b);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * The previous run's file lists, or `undefined` when there is nothing trustworthy
 * to prune against: no stamp, an older format, or a file that does not parse.
 */
const readStamp = (outputDirectory: string): StampFiles | undefined => {
    const path = join(outputDirectory, STAMP_FILE);

    if (!existsSync(path)) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }

    if (parsed === null || typeof parsed !== "object") {
        return undefined;
    }

    const { format, generatedFiles, transportFiles } = parsed as Record<string, unknown>;

    if (format !== STAMP_FORMAT || !isStringArray(generatedFiles) || !isStringArray(transportFiles)) {
        return undefined;
    }

    return { generatedFiles, transportFiles };
};

/**
 * Write the stamp beside the output. Called last, after the generated files are
 * on disk, so a run that fails part-way keeps the previous stamp and the next
 * run can still prune what the failed one left behind.
 *
 * Copy-in trades upgrades for independence: there is no version to bump, so the
 * only way to know which protocol a vendored transport speaks is to record it at
 * copy time. `versionMatched` is the field that matters — it answers whether the
 * transport and the surface above it came from one release, which is exactly what
 * the fallback path can silently break.
 */
const writeStamp = (outputDirectory: string, language: string, result: VendorResult, generatedFiles: ReadonlyArray<string>): void => {
    const stamp = {
        cliVersion: resolveCliVersion(),
        format: STAMP_FORMAT,
        generatedFiles: [...generatedFiles].toSorted(byPath),
        language,
        note: result.versionMatched
            ? "Vendored by `lunora sdk generate` at the ref matching the CLI that generated the surface beside it. Regenerate with a newer CLI to upgrade."
            : "Vendored by `lunora sdk generate` from a ref that is NOT this CLI's release tag, so the transport and the generated surface may be different protocol vintages.",
        ref: result.ref,
        source: result.source,
        transportFiles: [...result.transportFiles].toSorted(byPath),
        versionMatched: result.versionMatched,
    };

    writeFileSync(join(outputDirectory, STAMP_FILE), `${JSON.stringify(stamp, undefined, 4)}\n`, "utf8");
};

/** The comparable form of a stamp entry; a non-string has none and so matches nothing. */
const pathKey = (path: unknown): string | undefined => (typeof path === "string" ? normalize(path) : undefined);

/** True when `child` is `root` or sits beneath it. A bare prefix test would let `/a/bc` pass for `/a/b`. */
const isInside = (root: string, child: string): boolean => child === root || child.startsWith(`${root}${sep}`);

type Verdict = { absolute: string; identity: string; kind: "delete" } | { kind: "refuse"; reason: string } | { kind: "skip" };

/** Device and inode: two spellings name one file exactly when these match. */
const fileIdentity = (stats: Stats): string => `${String(stats.dev)}:${String(stats.ino)}`;

/**
 * Decide whether one previously-written path may be deleted. Every check must
 * pass; the order matters because the later ones touch the filesystem and assume
 * the earlier ones have already kept the path inside the output directory.
 */
const judge = (outputDirectory: string, candidate: unknown): Verdict => {
    if (typeof candidate !== "string" || candidate.length === 0 || isAbsolute(candidate)) {
        return { kind: "refuse", reason: "is not a relative path" };
    }

    const normalized = normalize(candidate);

    if (normalized.split(sep).includes("..")) {
        return { kind: "refuse", reason: "escapes the output directory" };
    }

    const absolute = resolve(outputDirectory, normalized);

    if (!isInside(outputDirectory, absolute)) {
        return { kind: "refuse", reason: "resolves outside the output directory" };
    }

    // A symlinked parent can redirect the delete to another directory even though
    // the lexical path looks inside. The parent is resolved, not the file, because
    // the file itself may be a symlink that lstat must see as one.
    let parentReal: string;

    try {
        parentReal = realpathSync(dirname(absolute));
    } catch {
        // The parent no longer exists, so neither does the file.
        return { kind: "skip" };
    }

    if (!isInside(realpathSync(outputDirectory), parentReal)) {
        return { kind: "refuse", reason: "its parent directory is a symlink that leads outside the output directory" };
    }

    let stats: Stats;

    try {
        stats = lstatSync(absolute);
    } catch {
        return { kind: "skip" };
    }

    if (stats.isSymbolicLink()) {
        return { kind: "refuse", reason: "is a symlink" };
    }

    if (!stats.isFile()) {
        return { kind: "refuse", reason: "is not a regular file" };
    }

    return { absolute, identity: fileIdentity(stats), kind: "delete" };
};

/** The identities of the files the current run wrote, so another spelling of one is never deleted. */
const keptFileIdentities = (outputDirectory: string, current: StampFiles): Set<string> => {
    const identities = new Set<string>();

    for (const path of [...current.transportFiles, ...current.generatedFiles]) {
        try {
            identities.add(fileIdentity(statSync(resolve(outputDirectory, path))));
        } catch {
            // Not on disk, so no candidate can be another name for it.
        }
    }

    return identities;
};

const deleteCandidate = (result: PruneResult, candidate: string, absolute: string): void => {
    try {
        unlinkSync(absolute);
        result.deleted.push(candidate);
    } catch (error) {
        // A read-only or locked file must not abort the run before the new stamp is written.
        result.refused.push({ path: candidate, reason: `could not be deleted (${(error as NodeJS.ErrnoException).code ?? "unknown error"})` });
    }
};

/**
 * Delete the files the previous run wrote and this one did not. Files the current
 * run still produces are kept, and so is anything a stamp never listed. Only files
 * are removed; a directory a previous run created stays, since the user may have
 * put things beside the generated ones.
 */
const pruneStale = (outputDirectory: string, previous: StampFiles | undefined, current: StampFiles): PruneResult => {
    const result: PruneResult = { deleted: [], refused: [] };

    if (previous === undefined) {
        return result;
    }

    // Compared by normalized path: a stamp may spell `lib/./a.dart` for the `lib/a.dart`
    // the run just wrote, and judge deletes the normalized path, so the raw spellings
    // would let a file the current run produced be deleted.
    const kept = new Set([...current.transportFiles, ...current.generatedFiles].map((path) => pathKey(path)).filter((key) => key !== undefined));
    const candidates = new Set([...previous.transportFiles, ...previous.generatedFiles]);
    // The string compare above misses spellings that still reach a file this run wrote: a
    // trailing slash, or another case on a case-insensitive filesystem.
    const keptFiles = keptFileIdentities(outputDirectory, current);

    for (const candidate of [...candidates].toSorted(byPath)) {
        // The stamp is rewritten at the end of the run, so pruning it would be
        // harmless, but a stamp that deletes itself is a bad thing to rely on.
        const key = pathKey(candidate);

        if ((key !== undefined && kept.has(key)) || key === STAMP_FILE) {
            continue;
        }

        const verdict = judge(outputDirectory, candidate);

        if (verdict.kind === "delete") {
            if (!keptFiles.has(verdict.identity)) {
                deleteCandidate(result, candidate, verdict.absolute);
            }
        } else if (verdict.kind === "refuse") {
            result.refused.push({ path: candidate, reason: verdict.reason });
        }
    }

    return result;
};

export type { PruneResult, StampFiles, VendorResult };
export { pruneStale, readStamp, STAMP_FILE, writeStamp };
