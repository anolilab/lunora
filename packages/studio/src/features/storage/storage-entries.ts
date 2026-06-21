import type { StorageObject } from "@lunora/client";

/**
 * Share-link lifetimes offered by the file browser's "Link expiry" control —
 * the seconds value forwarded to `signedStorageUrl` plus its human label.
 */
const SHARE_LIFETIMES = [
    { label: "15m", seconds: 900 },
    { label: "1h", seconds: 3600 },
    { label: "24h", seconds: 86_400 },
    { label: "7d", seconds: 604_800 },
] as const;

/** The default share-link lifetime applied by the per-row "Copy URL" action (1h). */
const DEFAULT_SHARE_LIFETIME = 3600;

/**
 * The comparable value for an object under a sort key — `size`, `type`, `date`,
 * `name`, or `tag:NAME` for a user-supplied customMetadata tag. Numbers for
 * size/date sort numerically; everything else compares as a locale string.
 */
// eslint-disable-next-line sonarjs/function-return-type -- numeric keys (size/date) sort numerically, the rest as strings; one comparator handles both
const fileSortValue = (object: StorageObject, key: string): number | string => {
    if (key === "size") {
        return object.size;
    }

    if (key === "type") {
        return object.httpMetadata?.contentType ?? "";
    }

    if (key === "date") {
        if (object.uploaded === undefined) {
            return 0;
        }

        // R2 sends an ISO string, a mock may send epoch ms — `new Date` handles
        // both. A bad string yields NaN, which makes the comparator
        // non-deterministic, so treat an unparseable date as the epoch (0).
        const time = new Date(object.uploaded).getTime();

        return Number.isNaN(time) ? 0 : time;
    }

    if (key.startsWith("tag:")) {
        return object.customMetadata?.[key.slice(4)] ?? "";
    }

    return object.key;
};

/** Sort a copy of the files by the chosen metadata key + direction (numeric or locale-aware). */
const sortFiles = (files: ReadonlyArray<StorageObject>, key: string, direction: "asc" | "desc"): StorageObject[] => {
    const factor = direction === "desc" ? -1 : 1;

    return files.toSorted((a, b) => {
        const av = fileSortValue(a, key);
        const bv = fileSortValue(b, key);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));

        return cmp * factor;
    });
};

/**
 * Split a flat object listing into the immediate folders and files at `prefix` —
 * R2-Explorer-style navigation derived client-side (the list is recursive, so a
 * key's first remaining `/`-segment is a sub-folder; a remainder with no slash is
 * a file at this level). Folders are de-duped and sorted; files keep list order.
 * Note: this reflects only the rows loaded so far — paginate (Load more) to surface
 * folders whose first key is further down the listing.
 */
const deriveEntries = (objects: ReadonlyArray<StorageObject>, prefix: string): { files: StorageObject[]; folders: string[] } => {
    const folders = new Set<string>();
    const files: StorageObject[] = [];

    for (const object of objects) {
        const rest = object.key.slice(prefix.length);
        const slash = rest.indexOf("/");

        if (slash === -1) {
            files.push(object);
        } else {
            folders.add(rest.slice(0, slash + 1));
        }
    }

    return { files, folders: [...folders].toSorted((a, b) => a.localeCompare(b)) };
};

export { DEFAULT_SHARE_LIFETIME, deriveEntries, fileSortValue, SHARE_LIFETIMES, sortFiles };
