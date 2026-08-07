/**
 * The transfer checkpoint: which source objects have already made it into R2.
 *
 * A bucket migration is the one part of an import that is genuinely expensive to
 * repeat — every object is a download from the old provider and an upload to the
 * new one, and a run that dies on object 40,000 of 50,000 has spent real time
 * and bandwidth. Content-hash keys already make re-uploading *safe*; the
 * checkpoint is what makes resuming *cheap*, by skipping the download too.
 *
 * The file is append-only NDJSON rather than a rewritten JSON blob, for two
 * reasons. Appending one line per object costs no re-serialisation as the run
 * grows, and a process killed mid-write leaves at most a torn final line — which
 * parses as garbage and is skipped, costing one repeated object rather than a
 * corrupt file that strands the whole migration.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "../../../util/logger";

/** One completed transfer: the provider-side `path` and the R2 `key` it landed at. */
interface TransferredObject {
    key: string;
    path: string;
    size: number;
}

/** Where a provider's checkpoint lives. Deliberately dot-prefixed: it is a resume artifact, not config. */
const progressFileFor = (provider: string): string => join("lunora", `.import-storage-${provider}.ndjson`);

/**
 * Read the checkpoint, returning what has already been transferred.
 *
 * A missing file is an empty result — the first run of a migration has no
 * history, and that is not an error. A malformed *line* is skipped rather than
 * fatal: it can only be the torn tail of a killed process, and the cost of
 * skipping it is re-transferring one object.
 */
const readTransferProgress = async (cwd: string, provider: string, logger: Logger): Promise<Map<string, TransferredObject>> => {
    const done = new Map<string, TransferredObject>();
    let content: string;

    try {
        content = await readFile(join(cwd, progressFileFor(provider)), "utf8");
    } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") {
            return done;
        }

        throw error;
    }

    let skipped = 0;

    for (const line of content.split("\n")) {
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            continue;
        }

        try {
            const entry = JSON.parse(trimmed) as TransferredObject;

            if (typeof entry.path === "string" && typeof entry.key === "string") {
                done.set(entry.path, entry);
            } else {
                skipped += 1;
            }
        } catch {
            // Only ever the final line of an interrupted run.
            skipped += 1;
        }
    }

    if (done.size > 0) {
        logger.info(
            `resuming: ${String(done.size)} object(s) already transferred${skipped > 0 ? ` (${String(skipped)} unreadable checkpoint line(s) ignored)` : ""}`,
        );
    }

    return done;
};

/** Record one completed transfer. Appended immediately, so the checkpoint never trails the work by more than one object. */
const recordTransfer = async (cwd: string, provider: string, entry: TransferredObject): Promise<void> => {
    const file = join(cwd, progressFileFor(provider));

    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
};

export type { TransferredObject };
export { progressFileFor, readTransferProgress, recordTransfer };
