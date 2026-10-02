/**
 * A job's failure, as the box reports it in `result.error` (protocol §5.1): a
 * machine-readable code and a human message. These are hostd protocol codes,
 * never `LunoraError`s, and never reach a client's wire mapper.
 */
import { HOSTD_PROTOCOL_LIMITS } from "../wire/constants";

/** Every code a job of this box fails with. */
type JobErrorCode =
    | "ALIAS_BUSY"
    | "ARTIFACT_INVALID"
    | "BUCKET_FAILED"
    | "CELLD_FAILED"
    | "FETCH_FAILED"
    | "HEALTH_TIMEOUT"
    | "JOB_FAILED"
    | "NO_FLEET"
    | "ORIGIN_REFUSED"
    | "PORTS_EXHAUSTED"
    | "RELEASE_INVALID"
    | "UPGRADE_REFUSED";

class JobError extends Error {
    public readonly code: JobErrorCode;

    public constructor(code: JobErrorCode, message: string) {
        super(message);
        this.name = "JobError";
        this.code = code;
    }
}

const utf8 = new TextEncoder();

/** Truncate `text` to `maxBytes` UTF-8 bytes, on a character boundary. */
const truncateUtf8 = (text: string, maxBytes: number): string => {
    if (utf8.encode(text).byteLength <= maxBytes) {
        return text;
    }

    let result = "";
    let bytes = 0;

    for (const character of text) {
        const size = utf8.encode(character).byteLength;

        if (bytes + size > maxBytes - 3) {
            break;
        }

        result += character;
        bytes += size;
    }

    return `${result}...`;
};

/** The `{code, message}` a failed job reports, whatever was thrown. */
const jobFailure = (error: unknown): { code: string; message: string } => {
    if (error instanceof JobError) {
        return { code: error.code, message: truncateUtf8(error.message, HOSTD_PROTOCOL_LIMITS.maxErrorMessageBytes) };
    }

    const message = error instanceof Error ? error.message : String(error);

    return { code: "JOB_FAILED", message: truncateUtf8(message, HOSTD_PROTOCOL_LIMITS.maxErrorMessageBytes) };
};

export type { JobErrorCode };
export { JobError, jobFailure, truncateUtf8 };
