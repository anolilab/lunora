/**
 * The `upgrade` job (plan 458 W7, protocol §8.3): install the release a signed
 * manifest pins — `lunora-hostd`, celld and Caddy — and switch the box to it.
 *
 * It refuses at the first failure and changes nothing until every artifact is
 * in hand and checked. The manifest is fetched with a signed request (its URL
 * must be on the enrolled control plane) and verified against the release keys
 * COMPILED INTO this binary — never a key the manifest or the control plane
 * brings; a placeholder key verifies nothing. A manifest for another release
 * than the job names is refused. The artifacts are downloaded from the URLs
 * the manifest pins, each capped at the size it pins, and installed by
 * `installRelease` (`release-install.ts`), exactly as `install.sh` installs a
 * release. When `lunora-hostd` itself changed, the daemon exits and systemd
 * starts the new one, which starts every child on the new binaries;
 * otherwise the fleets restart one at a time, then Caddy.
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import type { HostdReleaseArtifact, HostdReleasePlatform, TrustedReleaseKey } from "../release";
import { verifyReleaseManifest } from "../release";
import HOSTD_VERSION from "../version";
import type { UpgradeJob } from "../wire/types";
import type { HostdConfig } from "./config";
import { JobError } from "./job-error";
import { currentPlatform, installRelease } from "./release-install";
import type { SignedFetch } from "./signed-fetch";
import type { Supervisor } from "./supervisor";

/** The largest manifest envelope accepted; a real one is a few KiB. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** How long one artifact download may take. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

interface UpgradeOptions {
    config: HostdConfig;
    /** Plain fetch for the artifacts (GitHub release assets); injected for tests. */
    fetch?: typeof fetch;
    /** Called once `lunora-hostd`'s own binary was replaced: the daemon exits after the job's result is sent. */
    onSelfReplaced: () => void;
    platform?: HostdReleasePlatform;
    signedFetch: SignedFetch;
    supervisor: Supervisor;
    /** The release keys to trust: `HOSTD_TRUSTED_RELEASE_KEYS` in production. */
    trustedKeys: Readonly<Record<string, TrustedReleaseKey>>;
}

const readCapped = async (response: Response, maxBytes: number): Promise<string> => {
    const text = await response.text();

    if (text.length > maxBytes) {
        throw new JobError("UPGRADE_REFUSED", `the release manifest is over ${String(maxBytes)} bytes`);
    }

    return text;
};

/** Download `artifact` to `path`, refusing more bytes than it pins. */
const download = async (fetcher: typeof fetch, artifact: HostdReleaseArtifact, path: string): Promise<void> => {
    let response: Response;

    try {
        response = await fetcher(artifact.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
        throw new JobError("FETCH_FAILED", `could not download ${artifact.url}: ${(error as Error).message}`);
    }

    if (!response.ok || response.body === null) {
        throw new JobError("FETCH_FAILED", `${artifact.url} answered ${String(response.status)}`);
    }

    let received = 0;
    const capped = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
            received += chunk.byteLength;

            if (received > artifact.size) {
                controller.error(new JobError("ARTIFACT_INVALID", `${artifact.url} is larger than the ${String(artifact.size)} bytes the manifest pins`));

                return;
            }

            controller.enqueue(chunk);
        },
    });

    await pipeline(response.body.pipeThrough(capped), createWriteStream(path, { mode: 0o600 }));
};

/**
 * Run an `upgrade` job.
 * @throws {JobError} `UPGRADE_REFUSED` for a manifest that does not verify or names another release, `FETCH_FAILED` / `ARTIFACT_INVALID` for an artifact.
 */
const runUpgrade = async (job: UpgradeJob, options: UpgradeOptions, progress: (line: string) => void): Promise<void> => {
    const platform = options.platform ?? currentPlatform();

    if (platform === undefined) {
        throw new JobError("UPGRADE_REFUSED", `no release platform for ${process.platform}-${process.arch}`);
    }

    progress(`fetching release manifest ${job.releaseId}`);

    const response = await options.signedFetch(job.manifestUrl, { signal: AbortSignal.timeout(60_000) });

    if (response.status !== 200) {
        throw new JobError("FETCH_FAILED", `the control plane answered ${String(response.status)} for the release manifest`);
    }

    let envelope: unknown;

    try {
        envelope = JSON.parse(await readCapped(response, MAX_MANIFEST_BYTES));
    } catch (error) {
        throw error instanceof JobError ? error : new JobError("UPGRADE_REFUSED", "the release manifest is not JSON");
    }

    const verified = await verifyReleaseManifest(envelope, options.trustedKeys);

    if (!verified.ok) {
        throw new JobError("UPGRADE_REFUSED", `the release manifest does not verify: ${verified.error.code}: ${verified.error.message}`);
    }

    const { manifest } = verified.envelope;

    if (manifest.releaseId !== job.releaseId) {
        throw new JobError("UPGRADE_REFUSED", `the manifest is for release ${manifest.releaseId}, not ${job.releaseId}`);
    }

    progress(
        `manifest verified (key ${verified.envelope.keyId}): hostd ${manifest.hostd.version}, celld ${manifest.celld.version}, caddy ${manifest.caddy.version}`,
    );

    const fetcher = options.fetch ?? globalThis.fetch;
    const outcome = await installRelease({
        allowDowngrade: job.allowDowngrade === true,
        envelope: verified.envelope,
        installDir: options.config.installDir,
        obtain: async (component, artifact, path) => {
            progress(`downloading ${component} ${artifact.url}`);
            await download(fetcher, artifact, path);
        },
        platform,
        progress,
        runningVersion: HOSTD_VERSION,
    });

    if (!outcome.installed) {
        return;
    }

    if (manifest.hostd.version !== HOSTD_VERSION) {
        // The new lunora-hostd starts every child from current/ when systemd restarts it.
        progress(`lunora-hostd ${manifest.hostd.version} installed; restarting into it`);
        options.onSelfReplaced();

        return;
    }

    await options.supervisor.restartAll(progress);
};

export type { UpgradeOptions };
export { runUpgrade };
