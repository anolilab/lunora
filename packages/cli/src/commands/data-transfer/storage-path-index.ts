/**
 * Matching an application column's value to a transferred object.
 *
 * A transfer keys every object by its bucket-qualified path (`avatars/u1.png`),
 * because that is the only spelling guaranteed unique across a project. An
 * application column, though, holds whichever spelling the app happened to
 * store, and all three of these are ordinary:
 *
 * `avatars/u1.png` is bucket-qualified, what `list` returns. `u1.png` is
 * bucket-relative, what a client that already knows its bucket stores. And
 * `https://<ref>.supabase.co/storage/v1/object/public/avatars/u1.png` is what
 * `getPublicUrl()` returns, which is what most Supabase apps persist.
 *
 * Matching only the first leaves the other two unresolved, and an unresolved
 * path is not a warning the operator can act on: there is no mapping knob that
 * says "this column is bucket-relative". So the index carries every spelling,
 * and a bucket-relative name that is NOT unique across buckets is deliberately
 * left out — resolving `logo.png` to whichever bucket happened to be listed
 * first would rewrite a row to the wrong object, which is worse than saying so.
 */

const LEADING_SLASH_RE = /^\/+/;

/**
 * Supabase's object-URL prefix in each of its access modes. Everything after the
 * match is the bucket-qualified path.
 */
const SUPABASE_OBJECT_URL_RE = /\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?/;

/** Everything from the first `?` or `#` on is a signed URL's token, not the path. */
const URL_TAIL_RE = /[#?]/u;

/** A transfer indexed by every path spelling that resolves unambiguously to one key. */
type StoragePathIndex = ReadonlyMap<string, string>;

/**
 * Build the lookup index from a transfer's `bucket-qualified path → R2 key` map.
 *
 * Bucket-qualified paths always win: a bucket-relative name is added only when
 * exactly one object bears it AND no object is literally keyed by that name.
 */
const indexTransferredPaths = (transferred: ReadonlyMap<string, string>): StoragePathIndex => {
    const index = new Map(transferred);
    // `undefined` marks a name carried by more than one bucket — recorded so the
    // second sighting can retract the first rather than overwrite it.
    const relative = new Map<string, string | undefined>();

    for (const [path, key] of transferred) {
        const slash = path.indexOf("/");

        if (slash === -1) {
            continue;
        }

        const name = path.slice(slash + 1);

        // An object whose own qualified path is this name owns the spelling.
        if (name.length === 0 || transferred.has(name)) {
            continue;
        }

        relative.set(name, relative.has(name) ? undefined : key);
    }

    for (const [name, key] of relative) {
        if (key !== undefined) {
            index.set(name, key);
        }
    }

    return index;
};

/**
 * The bucket-qualified path inside a Supabase object URL, or `undefined` when
 * the value is not one.
 *
 * Query strings (the `?token=` on a signed URL) and fragments are dropped, and
 * the path is percent-decoded, because the listing returns raw names.
 */
const pathFromObjectUrl = (value: string): string | undefined => {
    const match = SUPABASE_OBJECT_URL_RE.exec(value);

    if (match === null) {
        return undefined;
    }

    const tail = value.slice(match.index + match[0].length).split(URL_TAIL_RE)[0] ?? "";

    if (tail.length === 0) {
        return undefined;
    }

    try {
        return decodeURIComponent(tail);
    } catch {
        // A malformed escape means this was never a URL we produced; fall back to
        // the raw tail rather than failing the whole row.
        return tail;
    }
};

/** Resolve one column value to a transferred object's key, or `undefined`. */
const resolveStoragePath = (value: string, index: StoragePathIndex): string | undefined => {
    const direct = index.get(value);

    if (direct !== undefined) {
        return direct;
    }

    const trimmed = value.replace(LEADING_SLASH_RE, "");
    const trimmedKey = index.get(trimmed);

    if (trimmedKey !== undefined) {
        return trimmedKey;
    }

    const fromUrl = pathFromObjectUrl(value);

    return fromUrl === undefined ? undefined : (index.get(fromUrl) ?? index.get(fromUrl.replace(LEADING_SLASH_RE, "")));
};

export type { StoragePathIndex };
export { indexTransferredPaths, resolveStoragePath };
