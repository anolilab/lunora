/**
 * Pure helpers for the "Export my data" action: the download's file name, and
 * the message shown when `GET /v1/account/export` refuses.
 */

/** `lunora-account-export-2026-10-11.json`, dated in UTC so it matches the export's own timestamps. */
export const accountExportFilename = (now: Date): string => `lunora-account-export-${now.toISOString().slice(0, 10)}.json`;

/**
 * The message for a non-OK export response.
 *
 * The route answers errors as `{ "error": "…" }`; a proxy or a crashed worker can
 * answer with plain text, HTML or nothing at all. Plain text is shown as is; the
 * rest fall back to the status code.
 */
export const accountExportErrorMessage = (status: number, body: string): string => {
    const text = body.trim();

    try {
        const parsed: unknown = JSON.parse(text);

        if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string" && parsed.error.trim() !== "") {
            return parsed.error;
        }
    } catch {
        // Not JSON: the raw body below is the best message there is.
    }

    // JSON without an `error`, or an HTML error page, says nothing a person can act on.
    const unreadable = text === "" || text.startsWith("{") || text.startsWith("<");

    return unreadable ? `could not export your data (HTTP ${String(status)})` : text;
};
