/** The `hostd-latest` pointer `install.sh` reads (see `update-latest-pointer.mjs`). */
declare interface LatestPointer {
    /** The newest release of any kind, for boxes on a pre-release. */
    prerelease: string;
    schema: 1;
    /** The newest release without a pre-release part; `null` until one is published. */
    stable: string | null;
}

declare const nextLatestPointer: (current: unknown, version: string, compare: (left: string, right: string) => -1 | 0 | 1 | undefined) => LatestPointer;

export default nextLatestPointer;
