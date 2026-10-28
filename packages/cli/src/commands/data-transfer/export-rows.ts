/**
 * Read a deployment's stored rows through `POST /_lunora/admin/export`, one
 * `{ table, doc }` at a time. The export route is the runtime's own, so the same
 * read reaches a Cloudflare, Node or celld deployment.
 */
import { LunoraError } from "@lunora/errors";

import type { StreamingFetchLike } from "./shared";
import { EXPORT_ENDPOINT_PATH } from "./shared";

interface ExportedRow {
    doc: Record<string, unknown>;
    table: string;
}

interface ExportTarget {
    baseUrl: string;
    fetchImpl: StreamingFetchLike;
    token: string;
}

/**
 * Call `onRow` for every row the deployment holds in `tables`, in export order.
 * `onRow` returning `false` stops the read and cancels the response, for a caller
 * that has seen enough.
 *
 * ponytail: the export route materialises each shard's rows in worker memory
 * before it streams (see `handleExport` in `@lunora/runtime`), so a read over a
 * very large shard fails there rather than here; a paged per-shard read is the
 * upgrade path if that ceiling is hit.
 */
const forEachExportedRow = async (target: ExportTarget, tables: ReadonlyArray<string>, onRow: (row: ExportedRow) => boolean | undefined): Promise<void> => {
    const response = await target.fetchImpl(`${target.baseUrl}${EXPORT_ENDPOINT_PATH}`, {
        body: JSON.stringify({ tables }),
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        method: "POST",
    });

    // Messages here name a status, a line number and a length, never response text: the drift gate prints
    // them, and a row fragment in an error body or a `JSON.parse` complaint would put stored values in CI logs.
    if (!response.ok) {
        throw new LunoraError("INTERNAL", `reading the deployment's rows failed (HTTP ${String(response.status)})`);
    }

    if (!response.body) {
        throw new LunoraError("INTERNAL", "reading the deployment's rows failed: the export response carried no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lineNumber = 0;

    // A line that is not a `{ table, doc }` row is a corrupt read, never a row to skip: a caller deciding
    // what to delete or whether data conforms must not act on a partial picture.
    const deliver = (line: string): boolean => {
        lineNumber += 1;

        if (line.trim().length === 0) {
            return true;
        }

        const corrupt = `reading the deployment's rows failed: export line ${String(lineNumber)} (${String(line.length)} characters) is not a { table, doc } row`;
        let parsed: { doc?: unknown; table?: unknown } | null;

        try {
            parsed = JSON.parse(line) as { doc?: unknown; table?: unknown } | null;
        } catch {
            throw new LunoraError("INTERNAL", corrupt);
        }

        if (parsed === null || typeof parsed.table !== "string" || parsed.doc === null || typeof parsed.doc !== "object") {
            throw new LunoraError("INTERNAL", corrupt);
        }

        return onRow({ doc: parsed.doc as Record<string, unknown>, table: parsed.table }) !== false;
    };

    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain until the reader signals `done`
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- stream chunks are read in order
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let newline = buffer.indexOf("\n");

            while (newline !== -1) {
                const line = buffer.slice(0, newline);

                buffer = buffer.slice(newline + 1);

                if (!deliver(line)) {
                    // eslint-disable-next-line no-await-in-loop -- one-shot cancel on early stop
                    await reader.cancel().catch(() => undefined);

                    return;
                }

                newline = buffer.indexOf("\n");
            }
        }

        deliver(buffer);
    } finally {
        reader.releaseLock();
    }
};

export type { ExportedRow, ExportTarget };
export { forEachExportedRow };
