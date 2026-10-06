/**
 * The platform account's suspended-hostnames list (plan 365 W8): a WAF custom
 * list of kind `hostname` that one operator-installed custom rule blocks
 * (`http.host in $&lt;list>`, in `http_request_firewall_custom`, before any Worker
 * runs). Hostname lists are Enterprise-only, so this exists only where the
 * operator set `LUNORA_SUSPENDED_HOSTS_LIST_ID`; elsewhere suspension falls back
 * to removing custom hostnames and the dispatcher's 503.
 *
 * The list is the control plane's alone: the edge-block sweep removes any item
 * it does not want, so nothing else may write to it.
 */
import type { CloudflareAccountAccess } from "./fetch";
import { cloudflareFetch } from "./fetch";

/** One list item, as the sweep diffs it. */
export interface HostListItem {
    hostname: string;
    id: string;
}

export interface HostList {
    /** Queue hostnames for blocking. Asynchronous on Cloudflare's side; adding a present one is harmless. */
    add: (hostnames: ReadonlyArray<string>) => Promise<void>;
    /** Every item, bounded: `truncated` when the read stopped at {@link MAX_LIST_PAGES}. */
    items: () => Promise<{ items: HostListItem[]; truncated: boolean }>;
    /** Queue items for removal by id. */
    remove: (ids: ReadonlyArray<string>) => Promise<void>;
}

/** Items per page — the API's maximum. */
const PAGE_SIZE = 500;

/** Pages read at most: 10,000 items, the account-wide list item limit. */
export const MAX_LIST_PAGES = 20;

/** Longest hostname (RFC 1035) and item id accepted from a list response. */
const MAX_HOSTNAME = 253;
const MAX_ID = 64;

/** A list item off the wire, or `undefined` when it is not a well-formed hostname item. */
const toItem = (raw: unknown): HostListItem | undefined => {
    const item = raw as { hostname?: { url_hostname?: unknown }; id?: unknown } | null;
    const hostname = item?.hostname?.url_hostname;
    const id = item?.id;

    return typeof hostname === "string" && typeof id === "string" && hostname.length <= MAX_HOSTNAME && id.length > 0 && id.length <= MAX_ID
        ? { hostname: hostname.toLowerCase(), id }
        : undefined;
};

export const createHttpHostList = (options: CloudflareAccountAccess & { listId: string }): HostList => {
    const call = cloudflareFetch(options);
    const path = `/accounts/${options.accountId}/rules/lists/${encodeURIComponent(options.listId)}/items`;

    return {
        add: async (hostnames) => {
            await call(path, {
                body: hostnames.map((hostname) => {
                    return { comment: "lunora: organization suspended", hostname: { url_hostname: hostname } };
                }),
                method: "POST",
            });
        },
        items: async () => {
            const items: HostListItem[] = [];
            let cursor: string | undefined;

            for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
                // eslint-disable-next-line no-await-in-loop -- cursor pagination is sequential by construction
                const answer = await call<unknown[]>(
                    `${path}?per_page=${String(PAGE_SIZE)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
                );

                for (const raw of answer?.result ?? []) {
                    const item = toItem(raw);

                    if (item !== undefined) {
                        items.push(item);
                    }
                }

                cursor = answer?.cursorAfter;

                if (cursor === undefined) {
                    return { items, truncated: false };
                }
            }

            return { items, truncated: true };
        },
        remove: async (ids) => {
            await call(path, {
                body: {
                    items: ids.map((id) => {
                        return { id };
                    }),
                },
                method: "DELETE",
            });
        },
    };
};
