/**
 * Signed `lunora-hostd` releases on the control plane (plan 458 W7, G17): the
 * versions a release installs, and which stored release every box is measured
 * against. An envelope is verified by `../hostd/release.ts`'s
 * `verifyReleaseManifest` — the same function a box runs — against the pinned
 * `HOSTD_TRUSTED_RELEASE_KEYS` (`POST /v1/hostd/releases`, `src/deploy/routes/hostd.ts`).
 */
import type { BoxVersions } from "../hostd/protocol";
import type { HostdReleaseEnvelope } from "../hostd/release";

/** The three versions a release installs — what a box's `hello` reports (`BoxVersions`), compared as a whole. */
export const versionsOf = (envelope: HostdReleaseEnvelope): BoxVersions => {
    return { caddy: envelope.manifest.caddy.version, celld: envelope.manifest.celld.version, hostd: envelope.manifest.hostd.version };
};

/**
 * The SHA-256 of install.sh from a stored envelope — only ever one that verified
 * before it was stored. `undefined` for a release signed before the manifest
 * pinned its installer.
 */
export const installerSha256Of = (envelope: string): string | undefined => {
    try {
        const sha256: unknown = (JSON.parse(envelope) as Partial<HostdReleaseEnvelope>).manifest?.installer?.sha256;

        return typeof sha256 === "string" ? sha256 : undefined;
    } catch {
        return undefined;
    }
};

/** One string per version set, so a fleet-upgrade plan can compare a box to a release. */
export const versionKey = (versions: BoxVersions): string => `hostd ${versions.hostd} / celld ${versions.celld} / caddy ${versions.caddy}`;

/** A stored release, as far as measuring boxes against it goes. `.global()` rows answer SQL NULL for an unset column. */
export interface StoredReleaseSummary {
    channel?: "canary" | "stable" | null;
    createdAt: number;
    releaseId: string;
    versions: BoxVersions;
}

/**
 * The newest stable release — what every box is measured against (plan 458 W7);
 * `undefined` before any is stored. A release without a channel is stable;
 * canaries go only to the boxes a rollout names.
 */
export const newestStableRelease = <T extends StoredReleaseSummary>(rows: ReadonlyArray<T>): T | undefined =>
    rows
        .filter((row) => row.channel !== "canary")
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .at(0);

interface Semver {
    core: bigint[];
    prerelease: string[];
}

const NUMBER = /^\d+$/u;
const IDENTIFIER = /^[0-9A-Za-z-]+$/u;

/** The order of two values of one ordered type, as -1, 0 or 1. */
const sign = <T extends bigint | string>(left: T, right: T): number => {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
};

/** A semantic version as lunora-hostd's `compare_versions` parses one (one leading `v`, no leading zeros), or `undefined`. */
const parseSemver = (version: string): Semver | undefined => {
    const parts = (version.startsWith("v") ? version.slice(1) : version).split("+");

    if (parts.length > 2) {
        return undefined;
    }

    const [release = ""] = parts;
    const dash = release.indexOf("-");
    const core = (dash === -1 ? release : release.slice(0, dash)).split(".");
    const prerelease = dash === -1 ? [] : release.slice(dash + 1).split(".");
    const coreValid = core.length === 3 && core.every((number) => NUMBER.test(number) && (number === "0" || !number.startsWith("0")));
    const identifiers = [...prerelease, ...parts.slice(1).flatMap((build) => build.split("."))];

    return coreValid && identifiers.every((identifier) => IDENTIFIER.test(identifier)) ? { core: core.map(BigInt), prerelease } : undefined;
};

/** Semver §11.4: numeric identifiers numerically and below alphanumeric ones, which compare in ASCII order. */
const compareIdentifiers = (left: string, right: string): number => {
    const leftNumeric = NUMBER.test(left);
    const rightNumeric = NUMBER.test(right);

    if (leftNumeric && rightNumeric) {
        return sign(BigInt(left), BigInt(right));
    }

    if (leftNumeric || rightNumeric) {
        return leftNumeric ? -1 : 1;
    }

    return sign(left, right);
};

/** Two prerelease lists by §11.4: a release without one is above any with one; otherwise identifier by identifier, then the shorter first. */
const comparePrereleases = (left: string[], right: string[]): number => {
    if (left.length === 0 || right.length === 0) {
        return Math.sign(right.length - left.length);
    }

    const differing = left
        .map((identifier, index) => (index < right.length ? compareIdentifiers(identifier, right[index] ?? "") : 0))
        .find((order) => order !== 0);

    return differing ?? Math.sign(left.length - right.length);
};

/**
 * The order of two versions as lunora-hostd's `compare_versions` (`apps/hostd/src/release.rs`)
 * decides it — a port rather than a semver package, since the box's parse is what the control
 * plane must agree with. `undefined` when either is not a semantic version.
 */
export const compareHostdVersions = (left: string, right: string): number | undefined => {
    const a = parseSemver(left);
    const b = parseSemver(right);

    if (a === undefined || b === undefined) {
        return undefined;
    }

    const core = a.core.map((part, index) => sign(part, b.core[index] ?? 0n)).find((order) => order !== 0);

    return core ?? comparePrereleases(a.prerelease, b.prerelease);
};

/**
 * Whether a box running `installed` would refuse `candidate` without `allowDowngrade`: its
 * `lunora-hostd` is older, or the two cannot be ordered — what the box's own anti-rollback
 * check (`assert_not_downgrade`) refuses. A box that reported no versions has nothing to refuse against.
 */
export const refusesWithoutDowngrade = (candidate: BoxVersions, installed: BoxVersions | undefined): boolean => {
    if (installed === undefined) {
        return false;
    }

    const order = compareHostdVersions(candidate.hostd, installed.hostd);

    return order === undefined || order < 0;
};
