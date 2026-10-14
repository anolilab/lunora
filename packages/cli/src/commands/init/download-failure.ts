/** Network / offline signatures: DNS, refused, fetch failures. */
const NETWORK_ERROR_PATTERN = /enotfound|eai_again|econnrefused|etimedout|network|fetch failed|getaddrinfo/u;

/** Not-found signatures: bad template name or bad ref. */
const NOT_FOUND_ERROR_PATTERN = /404|not found|could not find|no such/u;

/**
 * Classify an init template-download failure into a user-facing message plus
 * actionable next steps. Pure and dependency-free so it lives outside the large
 * `handler.ts` and can be unit-tested in isolation.
 */
const describeDownloadFailure = (error: unknown, context: { ref: string; remote: string; templateType: string }): { hints: string[]; message: string } => {
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();
    const genericMessage = `failed to download template "${context.templateType}" from ${context.remote}: ${raw}`;

    // Not found: bad template name or bad ref — the only case with a distinct message.
    if (NOT_FOUND_ERROR_PATTERN.test(lower)) {
        return {
            hints: [
                `Check the template name "${context.templateType}" and the ref "${context.ref}".`,
                "List/inspect available templates, or target a branch/tag with `--ref <branch>`.",
            ],
            message: `template "${context.templateType}" not found at ${context.remote}: ${raw}`,
        };
    }

    // Network / offline: the generic message, led by an offline diagnosis.
    if (NETWORK_ERROR_PATTERN.test(lower)) {
        return {
            hints: [
                "You appear to be offline or unable to reach GitHub.",
                "To scaffold without a network, point at a local template root: `lunora init --from <dir>`.",
            ],
            message: genericMessage,
        };
    }

    return {
        hints: ["If this is a network/offline issue, scaffold from a local root with `lunora init --from <dir>`."],
        message: genericMessage,
    };
};

export default describeDownloadFailure;
