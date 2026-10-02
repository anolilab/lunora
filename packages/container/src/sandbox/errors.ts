/**
 * Map `@cloudflare/sandbox` errors onto `LunoraError` codes, so a missing
 * file reads as `NOT_FOUND` rather than an opaque 500. The original
 * classification travels in `data`, which survives the RPC hop back to the
 * caller (workerd copies an error's own properties across).
 */
import { SandboxBackupError, SandboxFileError, SandboxProtocolError, SandboxS3MountError } from "@cloudflare/sandbox";
import type { LunoraErrorCode } from "@lunora/errors";
import { LunoraError } from "@lunora/errors";

/** Linux errnos with a clearer code than `BAD_REQUEST`. */
const ERRNO_CODES: Readonly<Record<string, LunoraErrorCode>> = {
    EACCES: "FORBIDDEN",
    EBUSY: "CONFLICT",
    EEXIST: "CONFLICT",
    ENOENT: "NOT_FOUND",
    ENOTEMPTY: "CONFLICT",
    EPERM: "FORBIDDEN",
};

const BACKUP_CODES: Readonly<Record<string, LunoraErrorCode>> = {
    BACKUP_INTEGRITY: "CONFLICT",
    BACKUP_NOT_FOUND: "NOT_FOUND",
    BACKUP_TRANSFER: "INTERNAL",
};

const MOUNT_CODES: Readonly<Record<string, LunoraErrorCode>> = {
    S3_MOUNT_BUSY: "CONFLICT",
    S3_MOUNT_CONFLICT: "CONFLICT",
    S3_MOUNT_FAILED: "INTERNAL",
    S3_MOUNT_INCOMPATIBLE: "BAD_REQUEST",
};

/** `error` as a `LunoraError` when it is a sandbox error, else `error` unchanged. */
const toSandboxError = (error: unknown, label: string): unknown => {
    if (SandboxFileError.is(error)) {
        const target = error.destination === undefined ? error.path : `${error.path} → ${error.destination}`;

        return new LunoraError(ERRNO_CODES[error.code] ?? "BAD_REQUEST", `${label}: ${error.operation} ${target} failed with ${error.code}: ${error.detail}`, {
            cause: error,
            data: {
                errno: error.code,
                operation: error.operation,
                path: error.path,
                ...(error.destination === undefined ? {} : { destination: error.destination }),
            },
        });
    }

    if (SandboxBackupError.is(error)) {
        return new LunoraError(
            BACKUP_CODES[error.code] ?? "INTERNAL",
            `${label}: ${error.operation} of ${error.path} failed (${error.code}): ${error.detail}`,
            {
                cause: error,
                data: { operation: error.operation, path: error.path, reason: error.code },
            },
        );
    }

    if (SandboxS3MountError.is(error)) {
        return new LunoraError(MOUNT_CODES[error.code] ?? "INTERNAL", `${label}: ${error.operation} at ${error.path} failed (${error.code}): ${error.detail}`, {
            cause: error,
            data: { operation: error.operation, path: error.path, reason: error.code },
        });
    }

    if (SandboxProtocolError.is(error)) {
        return new LunoraError("INTERNAL", `${label}: the container did not answer the sandbox helper protocol: ${error.detail}`, {
            cause: error,
            hint: "The image needs `sandbox-shim` at `/usr/local/bin/sandbox-shim` in a version matching `@cloudflare/sandbox`. Base it on Cloudflare's `cloudflare/sandbox` image.",
        });
    }

    return error;
};

export default toSandboxError;
