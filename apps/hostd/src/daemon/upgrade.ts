/**
 * The `upgrade` job (plan 458 W7, protocol §8.3): replace the box's binaries —
 * celld, Caddy and `lunora-hostd` itself — with the ones a signed release
 * manifest pins, then restart every child onto them.
 *
 * It refuses at the first failure and changes nothing until every artifact is
 * in hand and checked. The manifest is fetched with a signed request (its URL
 * must be on the enrolled control plane) and verified against the release keys
 * COMPILED INTO this binary — never a key the manifest or the control plane
 * brings; a placeholder key verifies nothing. A manifest for another release
 * than the job names is refused. Each artifact for this platform is
 * downloaded, its size and then its SHA-256 checked before it is decompressed,
 * and it is run once (`--version`) to prove it starts here. Then each binary is
 * swapped in with a rename, the fleets restart one at a time, then Caddy; when
 * `lunora-hostd` itself changed, the daemon exits for systemd to start the new
 * one.
 */
import { execFile } from "node:child_process";
import { chmodSync, createReadStream, createWriteStream, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type { HostdReleaseArtifact, HostdReleasePlatform, TrustedReleaseKey } from "../release";
import { verifyReleaseManifest } from "../release";
import { verifyArtifact } from "../release-verify";
import HOSTD_VERSION from "../version";
import type { UpgradeJob } from "../wire/types";
import type { HostdConfig } from "./config";
import { JobError } from "./job-error";
import type { SignedFetch } from "./signed-fetch";
import type { Supervisor } from "./supervisor";

/** The largest manifest envelope accepted; a real one is a few KiB. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** The release platform of the machine this runs on. */
const currentPlatform = (): HostdReleasePlatform | undefined => {
    if (process.platform !== "linux") {
        return undefined;
    }

    if (process.arch === "x64") {
        return "linux-x64";
    }

    return process.arch === "arm64" ? "linux-arm64" : undefined;
};

/** `binary {args}`'s first output line, or `undefined` when it does not run. */
const versionOutput = async (binary: string, args: ReadonlyArray<string>): Promise<string | undefined> =>
    new Promise((resolve) => {
        execFile(binary, args, { timeout: 10_000 }, (error, stdout) => {
            resolve(error === null ? stdout.split("\n")[0]?.trim() : undefined);
        });
    });

const WHITESPACE = /\s+/u;

const VERSION_START = /^v?\d/u;

const NOT_VERSION_CHARACTER = /[^\w.+~-]/gu;

/** The arguments that make each component print its version. */
const VERSION_ARGS = { caddy: ["version"], celld: ["--version"], hostd: ["--version"] } as const;

/** A version string as the protocol accepts it (`[A-Za-z0-9_.+~-]{1,64}`), from `celld 0.6.0` / `v2.11.6 h1:…` / `1.0.0`. */
const versionToken = (output: string | undefined): string => {
    const token = output
        ?.split(WHITESPACE)
        .find((part) => VERSION_START.test(part))
        ?.replaceAll(NOT_VERSION_CHARACTER, "");

    return token === undefined || token === "" ? "unknown" : token.slice(0, 64);
};

/** The installed versions of celld and Caddy, as `hello.versions` reports them. */
const installedVersions = async (config: HostdConfig): Promise<{ caddy: string; celld: string; hostd: string }> => {
    const [celld, caddy] = await Promise.all([
        versionOutput(config.binaries.celld, VERSION_ARGS.celld),
        versionOutput(config.binaries.caddy, VERSION_ARGS.caddy),
    ]);

    return { caddy: versionToken(caddy), celld: versionToken(celld), hostd: HOSTD_VERSION };
};

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
        response = await fetcher(artifact.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
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

/** One component to install: where it goes, and the artifact that replaces it. */
interface Install {
    artifact: HostdReleaseArtifact;
    component: "caddy" | "celld" | "hostd";
    target: string;
}

/** Download, check and stage one component next to its target as `{target}.new`. */
const stage = async (fetcher: typeof fetch, install: Install, progress: (line: string) => void): Promise<string> => {
    const downloaded = `${install.target}.download`;
    const staged = `${install.target}.new`;

    progress(`downloading ${install.component} ${install.artifact.url}`);
    await download(fetcher, install.artifact, downloaded);

    const checked = await verifyArtifact(downloaded, install.artifact.sha256, install.artifact.size);

    if (!checked.ok) {
        rmSync(downloaded, { force: true });
        throw new JobError("ARTIFACT_INVALID", `${install.component}: ${checked.error.code}: ${checked.error.message}`);
    }

    if (install.artifact.compression === "gzip") {
        await pipeline(createReadStream(downloaded), createGunzip(), createWriteStream(staged, { mode: 0o600 }));
        rmSync(downloaded, { force: true });
    } else {
        renameSync(downloaded, staged);
    }

    chmodSync(staged, 0o755);

    const printed = await versionOutput(staged, VERSION_ARGS[install.component]);

    if (printed === undefined) {
        rmSync(staged, { force: true });
        throw new JobError("ARTIFACT_INVALID", `${install.component} from ${install.artifact.url} does not run on this machine`);
    }

    progress(`${install.component} verified: ${printed}`);

    return staged;
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

    const artifactOf = (component: "caddy" | "celld" | "hostd"): HostdReleaseArtifact => {
        const found = manifest[component].artifacts.find((artifact) => artifact.platform === platform);

        if (found === undefined) {
            throw new JobError("UPGRADE_REFUSED", `release ${manifest.releaseId} ships no ${component} for ${platform}`);
        }

        return found;
    };

    const { binaries } = options.config;
    const installs: Install[] = [
        { artifact: artifactOf("celld"), component: "celld", target: binaries.celld },
        { artifact: artifactOf("caddy"), component: "caddy", target: binaries.caddy },
    ];

    // hostd replaces itself only when it runs as an installed binary, and only for a new version.
    if (binaries.hostd !== undefined && manifest.hostd.version !== HOSTD_VERSION) {
        installs.push({ artifact: artifactOf("hostd"), component: "hostd", target: binaries.hostd });
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    const staged: { install: Install; path: string }[] = [];

    try {
        for (const install of installs) {
            // eslint-disable-next-line no-await-in-loop -- one download at a time on a small box
            staged.push({ install, path: await stage(fetcher, install, progress) });
        }
    } catch (error) {
        for (const { path } of staged) {
            rmSync(path, { force: true });
        }

        throw error;
    }

    for (const { install, path } of staged) {
        renameSync(path, install.target);
        progress(`installed ${install.component} at ${install.target}`);
    }

    await options.supervisor.restartAll(progress);

    if (staged.some(({ install }) => install.component === "hostd")) {
        progress(`lunora-hostd ${manifest.hostd.version} installed; restarting into it`);
        options.onSelfReplaced();
    }
};

export type { UpgradeOptions };
export { currentPlatform, installedVersions, runUpgrade, versionToken };
