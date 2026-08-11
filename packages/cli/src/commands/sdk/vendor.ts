/**
 * Copying a language's hand-written transport into the generated SDK, so the
 * output runs with no Lunora package installed anywhere.
 *
 * The fetch is the registry's: `resolveItemDirectory` from
 * `commands/registry/resolve.ts`, pointed at `gh:anolilab/lunora/sdks` instead of
 * `.../registry`. That reuse is deliberate — it inherits the `--source` gate, the
 * giget staging directory and its cleanup, and `--from` for offline use, none of
 * which would stay in step with a second copy.
 *
 * What is NOT the registry's is the ref. Registry items and project templates
 * track a release BRANCH, because a component's markup is not versioned against
 * the CLI. A transport is: it implements the wire protocol the emitter beside it
 * generates calls against. So the default ref is the CLI's own release tag
 * ({@link resolveCliVersionRef}), which makes a regeneration an upgrade — a newer
 * CLI brings the transport released with it — and makes "which protocol vintage do
 * I hold" answerable from the stamp this module writes.
 */

import { cpSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import type { SdkTarget } from "@lunora/codegen";
import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../util/logger";
import { resolveCliVersion, resolveCliVersionRef, resolvePinnedSourceRef } from "../../util/source-ref";
import { resolveItemDirectory } from "../registry/resolve";
import type { AddCommandOptions } from "../registry/types";

/** The giget base the transports are fetched from, mirroring the registry's. */
const SDK_SOURCE_BASE = "gh:anolilab/lunora/sdks";

/** The sidecar recording which transport vintage the output holds. */
const STAMP_FILE = "lunora-transport.json";

/**
 * Test-suite filenames, excluded from the copy in every language.
 *
 * A transport's suite asserts against `protocol/fixtures/`, which is not part of
 * the output, so a vendored copy could only fail. The `vendor` lists already keep
 * whole test DIRECTORIES out; this catches the case those lists cannot — Go keeps
 * `*_test.go` beside the sources it tests, so `sdks/go/lunora` is both the runtime
 * and its own suite.
 */
const TEST_SUFFIX = /_test\.|Tests?\./u;

const isTestFile = (name: string): boolean => name.startsWith("test_") || TEST_SUFFIX.test(name);

/** Every file under `directory`, as paths relative to it, sorted. */
const walk = (directory: string, prefix = ""): string[] =>
    readdirSync(directory)
        .toSorted((a, b) => a.localeCompare(b))
        .flatMap((entry) => {
            const absolute = join(directory, entry);
            const relativePath = prefix.length > 0 ? `${prefix}/${entry}` : entry;

            return statSync(absolute).isDirectory() ? walk(absolute, relativePath) : [relativePath];
        });

/** What a completed vendoring recorded, for the stamp and the CLI's report. */
interface VendorResult {
    /** Paths written, relative to the output directory, sorted. */
    files: ReadonlyArray<string>;
    /** The ref the transport actually came from. */
    ref: string;
    /** Where it came from: the giget base, or the local `--from` directory. */
    source: string;
    /** True when the ref above is the running CLI's own release tag. */
    versionMatched: boolean;
}

/**
 * Copy one `vendor` entry. Returns the destination paths written.
 *
 * `cpSync`'s filter rather than a hand-rolled walk: it already creates parents,
 * copies recursively and preserves file modes, and a filter returning `false` for
 * a directory prunes the whole subtree.
 */
const copyEntry = (sourceRoot: string, outputDirectory: string, from: string, to: string): string[] => {
    const source = join(sourceRoot, from);

    if (!existsSync(source)) {
        throw new LunoraError("NOT_FOUND", `transport is missing ${from}`);
    }

    const destination = join(outputDirectory, to);

    cpSync(source, destination, {
        filter: (candidate) => !isTestFile(candidate.slice(candidate.lastIndexOf(sep) + 1)),
        force: true,
        recursive: true,
    });

    // `to` is a file when the source was; only a directory has children to walk.
    return statSync(destination).isDirectory() ? walk(destination).map((child) => `${to}/${child}`) : [to];
};

/**
 * True when `directory` holds this target's transport.
 *
 * Load-bearing, and not a redundant check on a fetch that already succeeded:
 * giget resolves `gh:owner/repo/<subdir>#<ref>` by downloading the whole tarball
 * and extracting the subdir, and when the subdir is ABSENT at that ref it reports
 * success and leaves an EMPTY directory. Measured against
 * `sdks/go#@lunora/cli@1.0.0-alpha.157`, where only `sdks/python` exists. Without
 * this, that fetch would "succeed" and the output would ship a generated surface
 * with no transport under it — a self-contained SDK that imports nothing.
 */
const carriesTransport = (directory: string, target: SdkTarget): boolean => target.vendor.every((entry) => existsSync(join(directory, entry.from)));

/**
 * Fetch the transport at one ref and copy it. Returns `undefined` when that ref
 * does not carry this language's transport, so the caller can fall back; a real
 * failure (a 404 on the ref itself, a broken network) still throws.
 */
const vendorAtRef = async (
    ref: string,
    options: { language: string; logger: Logger; outputDirectory: string; registryOptions: AddCommandOptions; target: SdkTarget },
): Promise<VendorResult | undefined> => {
    const { language, logger, outputDirectory, registryOptions, target } = options;
    const { cleanup, directory } = await resolveItemDirectory(language, { ...registryOptions, ref }, SDK_SOURCE_BASE);

    try {
        if (!carriesTransport(directory, target)) {
            logger.warn(`${SDK_SOURCE_BASE}/${language} does not exist at ${ref}.`);

            return undefined;
        }

        return {
            files: target.vendor.flatMap((entry) => copyEntry(directory, outputDirectory, entry.from, entry.to)).toSorted((a, b) => a.localeCompare(b)),
            ref,
            source: `${SDK_SOURCE_BASE}/${language}`,
            versionMatched: ref === resolveCliVersionRef(),
        };
    } finally {
        cleanup();
    }
};

/** Copy the transport straight out of a local `--from` directory. */
const vendorFromLocal = (from: string, options: { language: string; outputDirectory: string; target: SdkTarget }): VendorResult => {
    const { language, outputDirectory, target } = options;
    const directory = join(from, language);

    if (!existsSync(directory)) {
        throw new LunoraError("NOT_FOUND", `no transport at ${directory} — --from must point at a directory of per-language transports (the repo's \`sdks/\`)`);
    }

    if (!carriesTransport(directory, target)) {
        const wanted = target.vendor.map((entry) => entry.from).join(", ");

        throw new LunoraError("NOT_FOUND", `${directory} is not a ${language} transport — expected it to contain ${wanted}`);
    }

    return {
        files: target.vendor.flatMap((entry) => copyEntry(directory, outputDirectory, entry.from, entry.to)).toSorted((a, b) => a.localeCompare(b)),
        // Deliberately not a git ref. The stamp's job is to say what the output
        // holds, and a working copy is whatever it is on disk — recording the
        // checkout's HEAD would claim a provenance the files may not have.
        ref: "local",
        source: directory,
        versionMatched: false,
    };
};

/**
 * Copy the transport for `target` into `outputDirectory`, and stamp it.
 *
 * Ref resolution runs in two steps. FIRST, an explicit `ref` — a user or CI
 * pinning deliberately — which never falls back, because a pin that quietly
 * resolves elsewhere is worse than an error. OTHERWISE the CLI's own release tag;
 * and if that ref has no transport for this language, fall back to the release
 * branch and SAY SO, since a user who believes they hold a version-matched
 * transport and does not is worse off than one who knows they are on a fallback.
 *
 * `from` short-circuits both: it is the offline path, and the one CI uses, since
 * a language added on an unmerged branch has no tag carrying it yet.
 */
const vendorTransport = async (options: {
    allowUnsafeSource: boolean | undefined;
    from: string | undefined;
    language: string;
    logger: Logger;
    outputDirectory: string;
    ref: string | undefined;
    source: string | undefined;
    target: SdkTarget;
}): Promise<VendorResult> => {
    const { allowUnsafeSource, from, language, logger, outputDirectory, ref, source, target } = options;

    if (from !== undefined) {
        return vendorFromLocal(from, { language, outputDirectory, target });
    }

    // The registry's option bag, which carries the `--source` gate and the ref
    // pinning. `names` is the registry command's positional list and has no
    // meaning for a transport.
    const registryOptions: AddCommandOptions = { allowUnsafeSource, logger, names: [], source };

    // `candidate` is optional because that is how the fallback is spelt: passing
    // no ref is what makes `resolvePinnedSourceRef` derive the version's release
    // BRANCH (and pin it to a SHA), which is precisely the fallback target.
    const attempt = async (candidate: string | undefined): Promise<VendorResult | undefined> =>
        vendorAtRef(await resolvePinnedSourceRef(candidate, logger), { language, logger, outputDirectory, registryOptions, target });

    if (ref !== undefined && ref.length > 0) {
        const pinned = await attempt(ref);

        if (pinned === undefined) {
            throw new LunoraError(
                "NOT_FOUND",
                `--ref ${ref} carries no ${language} transport — pick a ref that does, or pass --from <dir> to copy a local one`,
            );
        }

        return pinned;
    }

    const versionRef = resolveCliVersionRef();
    const matched = await attempt(versionRef).catch((error: unknown) => {
        // An unreleased CLI (a dev build, or a version whose tag is not cut yet)
        // has no tag to fetch, which is a 404 on the ref rather than a missing
        // subdir. Same outcome as a missing transport: fall back, loudly.
        const reason = error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);

        logger.warn(`could not fetch the transport at ${versionRef} (${reason}).`);

        return undefined;
    });

    if (matched !== undefined) {
        return matched;
    }

    const fallback = await attempt(undefined);

    if (fallback === undefined) {
        throw new LunoraError(
            "NOT_FOUND",
            `no ${language} transport at ${versionRef} or on the release branch. This language may not be released yet —` +
                ` pass --from <dir> to copy one from a checkout, or --ref <tag> to name a ref that has it.`,
        );
    }

    logger.warn(
        `FALLBACK: the transport is NOT version-matched to this CLI (${resolveCliVersion()}). Wanted ${versionRef}, used ${fallback.ref}.` +
            ` The vendored wire protocol may not be the one this surface was generated against; ${STAMP_FILE} records what was actually copied.`,
    );

    return fallback;
};

/**
 * Write the vintage stamp beside the copy.
 *
 * Copy-in trades upgrades for independence: there is no version to bump, so the
 * only way to know which protocol a vendored transport speaks is to record it at
 * copy time. `versionMatched` is the field that matters — it answers whether the
 * transport and the surface above it came from one release, which is exactly what
 * the fallback path can silently break.
 */
const writeStamp = (outputDirectory: string, language: string, result: VendorResult): void => {
    const stamp = {
        cliVersion: resolveCliVersion(),
        files: result.files,
        language,
        note: result.versionMatched
            ? "Vendored by `lunora sdk generate` at the ref matching the CLI that generated the surface beside it. Regenerate with a newer CLI to upgrade."
            : "Vendored by `lunora sdk generate` from a ref that is NOT this CLI's release tag, so the transport and the generated surface may be different protocol vintages.",
        ref: result.ref,
        source: result.source,
        versionMatched: result.versionMatched,
    };

    writeFileSync(join(outputDirectory, STAMP_FILE), `${JSON.stringify(stamp, undefined, 4)}\n`, "utf8");
};

export { STAMP_FILE, vendorTransport, writeStamp };
export type { VendorResult };
