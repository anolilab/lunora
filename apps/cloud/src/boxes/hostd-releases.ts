/**
 * Signed `lunora-hostd` releases on the control plane (plan 458 W7, G17): the
 * versions a release installs, and which stored release every box is measured
 * against. An envelope is verified by `@lunora/hostd/release`'s
 * `verifyReleaseManifest` — the same function a box runs — against the pinned
 * `HOSTD_TRUSTED_RELEASE_KEYS` (`POST /v1/hostd/releases`, `src/deploy/routes/hostd.ts`).
 */
import type { BoxVersions } from "@lunora/hostd/protocol";
import type { HostdReleaseEnvelope } from "@lunora/hostd/release";

/** The three versions a release installs — what a box's `hello` reports (`BoxVersions`), compared as a whole. */
export const versionsOf = (envelope: HostdReleaseEnvelope): BoxVersions => {
    return { caddy: envelope.manifest.caddy.version, celld: envelope.manifest.celld.version, hostd: envelope.manifest.hostd.version };
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
