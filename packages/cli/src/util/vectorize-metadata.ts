/**
 * Provision the Vectorize **metadata indexes** a schema's `.vectorize()`
 * declarations imply.
 *
 * `.vectorize(field, { metadata: ["authorId"] })` mirrors those columns into
 * each vector's metadata, and `ctx.vectors.query(name, { filter })` filters on
 * them. Cloudflare only allows filtering on a property that has an explicit
 * metadata index, created out of band — declaring the field is not enough. The
 * failure mode is silent and nasty: filters behave locally (test doubles filter
 * in memory) and come back empty against the real index, with no error.
 *
 * So the schema's declaration is treated as the source of truth and the indexes
 * are created to match, idempotently, as a post-deploy step. Creating one that
 * already exists is the normal case, not a failure.
 */
import type { Logger } from "./logger";
import type { Spawner, SpawnResult } from "./spawn";

/** Metadata property types Vectorize can index. */
type VectorMetadataType = "boolean" | "number" | "string";

/** One metadata index a schema declares: filter property `property` on index `index`. */
interface VectorMetadataIndex {
    index: string;
    property: string;
    type: VectorMetadataType;
}

/**
 * Map a column's validator kind to the metadata type Vectorize indexes it as.
 * Anything else (objects, arrays, bytes) can be *stored* as metadata but not
 * filtered on, so it yields `undefined` and the caller reports it rather than
 * creating an index that could never work.
 */
const metadataTypeFor = (kind: string | undefined): VectorMetadataType | undefined => {
    switch (kind) {
        case "boolean": {
            return "boolean";
        }
        case "date":
        case "number":
        case "timestamp": {
            return "number";
        }
        case "id":
        case "literal":
        case "string": {
            return "string";
        }
        default: {
            return undefined;
        }
    }
};

/** Vectorize rejects a create when the property is already indexed; that is success, not failure. */
const ALREADY_EXISTS = /already (?:exists|indexed)|duplicate/iu;

/**
 * The `wrangler` invocation that creates one metadata index. Exposed so
 * `doctor` can print the exact command a user needs without shelling out.
 */
const createMetadataIndexArgs = (entry: VectorMetadataIndex): string[] => [
    "vectorize",
    "create-metadata-index",
    entry.index,
    `--property-name=${entry.property}`,
    `--type=${entry.type}`,
];

/** One provisioning attempt's outcome, for the caller's summary. */
interface VectorMetadataResult {
    entry: VectorMetadataIndex;
    /** Present when the create failed for a reason other than "already exists". */
    error?: string;
    status: "created" | "exists" | "failed";
}

/**
 * One `wrangler` invocation, with a spawn-level failure reported rather than
 * thrown.
 *
 * The spawner rejects when the child process cannot start at all (a missing
 * binary, a fork failure), and nothing between here and the command handler
 * catches it — so without this the promise below would turn a *post-deploy*
 * provisioning hiccup into a failed deploy: the worker is already live, the
 * schema-baseline re-bless is skipped, and under `--format json` the caller
 * parsing stdout gets nothing at all.
 */
const runOne = async (spawner: Spawner, descriptor: Parameters<Spawner>[0]): Promise<SpawnResult> => {
    try {
        return await spawner(descriptor);
    } catch (error) {
        return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * Create every declared metadata index, in order, tolerating the ones that
 * already exist. Never throws: a Vectorize index that hasn't been created yet
 * (or an unauthenticated shell) should degrade to a reported warning, not a
 * failed deploy — the worker itself is already live by this point.
 */
const ensureVectorMetadataIndexes = async (inputs: {
    cwd: string;
    entries: ReadonlyArray<VectorMetadataIndex>;
    /** The package-manager invocation for `wrangler`, as `execArgsFor` returns it. */
    exec: { args: ReadonlyArray<string>; command: string };
    logger: Logger;
    spawner: Spawner;
}): Promise<VectorMetadataResult[]> => {
    const { cwd, entries, exec, logger, spawner } = inputs;
    const results: VectorMetadataResult[] = [];

    for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop -- wrangler invocations are sequential by nature; parallel ones interleave their output
        const result = await runOne(spawner, {
            args: [...exec.args, ...createMetadataIndexArgs(entry)],
            // stderr, not stdout: wrangler reports the already-exists case as an
            // error there, and stdout has to stay clean for `--format json`.
            captureStderr: true,
            command: exec.command,
            cwd,
            stdoutToStderr: true,
        });

        if (result.code === 0) {
            results.push({ entry, status: "created" });

            continue;
        }

        const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;

        if (ALREADY_EXISTS.test(output)) {
            results.push({ entry, status: "exists" });

            continue;
        }

        results.push({ entry, error: output.trim() || `exit code ${String(result.code)}`, status: "failed" });
        logger.warn(
            `could not create the Vectorize metadata index for "${entry.property}" on "${entry.index}" — filters on that property will match nothing until it exists. Run: wrangler ${createMetadataIndexArgs(entry).join(" ")}`,
        );
    }

    return results;
};

export type { VectorMetadataIndex, VectorMetadataResult, VectorMetadataType };
export { createMetadataIndexArgs, ensureVectorMetadataIndexes, metadataTypeFor };
