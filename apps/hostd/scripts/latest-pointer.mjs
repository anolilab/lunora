/**
 * The `hostd-latest` pointer's next value (see `update-latest-pointer.mjs`):
 * `stable`, the newest release without a pre-release part, and `prerelease`,
 * the newest release of any kind — each only ever moving forward.
 *
 * Pure, with the version order injected (`compareReleaseVersions` from
 * `@lunora/hostd/release`), so the tests run it on the source.
 * @param {unknown} current the pointer as published, or anything unreadable
 * @param {string} version the release just published
 * @param {(left: string, right: string) => -1 | 0 | 1 | undefined} compare orders two versions, `undefined` when either is not a semantic version
 * @returns {{ prerelease: string, schema: 1, stable: string | null }} the pointer to publish
 */
const nextLatestPointer = (current, version, compare) => {
    if (compare(version, version) === undefined) {
        throw new Error(`${version} is not a semantic version: boxes could not order it against their own`);
    }

    const field = (name) => {
        const value = typeof current === "object" && current !== null ? current[name] : undefined;

        // A JSON field of the published pointer: `null` until a stable release exists.
        // eslint-disable-next-line unicorn/no-null -- see above
        return typeof value === "string" && compare(value, value) !== undefined ? value : null;
    };
    const newer = (existing) => (existing !== null && compare(existing, version) >= 0 ? existing : version);
    const isPrerelease = version.split("+")[0].includes("-");
    const stable = isPrerelease ? field("stable") : newer(field("stable"));
    const prerelease = newer(field("prerelease"));

    return { prerelease: stable !== null && compare(stable, prerelease) > 0 ? stable : prerelease, schema: 1, stable };
};

export default nextLatestPointer;
