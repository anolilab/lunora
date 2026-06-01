import type { StorageObject } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { errorMessage, formatBytes } from "./internal.js";

interface FileBrowserProps {
    /** Object-key prefix the browser filters by on first load. */
    readonly initialPrefix?: string;
    /** Objects requested per page. Forwarded to the storage `list` limit. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Browse objects in the storage (R2) bucket. Lists keys under an optional prefix
 * via the client's `listStorageObjects`, which hits the worker's admin-gated
 * `GET /_cirrus/admin/storage` endpoint — so the worker must be built with a
 * `storageList` function and `adminToken`. Paginates forward by cursor.
 *
 * Read-only: surfaces key, size and content-type. Uploads/deletes are out of
 * scope; the host's own storage API owns mutations.
 */
export function FileBrowser({ initialPrefix, pageSize = DEFAULT_PAGE_SIZE }: FileBrowserProps): ReactElement {
    const client = useCirrus();

    const [prefix, setPrefix] = useState<string>(initialPrefix ?? "");
    const [objects, setObjects] = useState<StorageObject[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);
    // Cursor stack so "Next" walks forward and we can show whether more remain.
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

    const list = useCallback(
        async (searchPrefix: string, cursor: string | undefined, append: boolean): Promise<void> => {
            setError(null);
            setBusy(true);

            try {
                const page = await client.listStorageObjects({ cursor, limit: pageSize, prefix: searchPrefix });

                setObjects((previous) => (append && previous !== null ? [...previous, ...page.objects] : page.objects));
                setNextCursor(page.cursor);
            } catch (error_) {
                if (!append) {
                    setObjects(null);
                }

                setError(errorMessage(error_));
            } finally {
                setBusy(false);
            }
        },
        [client, pageSize],
    );

    useEffect(() => {
        void list(initialPrefix ?? "", undefined, false);
    }, [list, initialPrefix]);

    return (
        <div data-testid="cirrus-file-browser">
            <div>
                <input
                    aria-label="Key prefix"
                    data-testid="fb-prefix-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setPrefix(event.target.value);
                    }}
                    placeholder="key prefix (optional)"
                    value={prefix}
                />
                <button
                    data-testid="fb-list"
                    disabled={busy}
                    onClick={() => {
                        void list(prefix, undefined, false);
                    }}
                    type="button"
                >
                    List
                </button>
            </div>

            {error !== null && (
                <p data-testid="fb-error" role="alert">
                    {error}
                </p>
            )}

            {objects !== null && objects.length === 0 && <p data-testid="fb-empty">No objects.</p>}

            {objects !== null && objects.length > 0 && (
                <table data-testid="fb-table">
                    <thead>
                        <tr>
                            <th>key</th>
                            <th>size</th>
                            <th>content-type</th>
                        </tr>
                    </thead>
                    <tbody>
                        {objects.map((object) => (
                            <tr data-testid="fb-row" key={object.key}>
                                <td>{object.key}</td>
                                <td>{formatBytes(object.size)}</td>
                                <td>{object.httpMetadata?.contentType ?? ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {nextCursor !== undefined && (
                <button
                    data-testid="fb-next"
                    disabled={busy}
                    onClick={() => {
                        void list(prefix, nextCursor, true);
                    }}
                    type="button"
                >
                    Load more
                </button>
            )}
        </div>
    );
}

export type { FileBrowserProps };
