/**
 * The `upgrade` job (plan 458 W7, protocol §8.3): install the release a signed
 * manifest pins — `lunora-hostd`, celld and Caddy — and switch the box to it.
 *
 * Releases live side by side, as `install.sh` lays them out:
 * `{installDir}/{releaseId}/{lunora-hostd,celld,caddy,manifest.json}`, with
 * `{installDir}/current` a symlink to the one that runs. The systemd unit
 * starts `current/lunora-hostd`, and every child is started from `current/`.
 *
 * It refuses at the first failure and changes nothing until every artifact is
 * in hand and checked. The manifest is fetched with a signed request (its URL
 * must be on the enrolled control plane) and verified against the release keys
 * COMPILED INTO this binary — never a key the manifest or the control plane
 * brings; a placeholder key verifies nothing. A manifest for another release
 * than the job names is refused. Each artifact for this platform is
 * downloaded into `{releaseId}.partial/`, its size and then its SHA-256
 * checked before it is decompressed, and it is run once (`--version`) to
 * prove it starts here. Then the directory is renamed into place and
 * `current` swapped to it in one rename. When `lunora-hostd` itself changed,
 * the daemon exits and systemd starts the new one, which starts every child
 * on the new binaries; otherwise the fleets restart one at a time, then
 * Caddy. The release that ran before stays, for a manual rollback (point
 * `current` back at it); older ones are removed.
 */
import { execFile } from "node:child_process";
import {
    chmodSync,
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type { HostdReleaseArtifact, HostdReleasePlatform, TrustedReleaseKey } from "../release";
import { verifyReleaseManifest } from "../release";
import { verifyArtifact } from "../release-verify";
import HOSTD_VERSION from "../version";
import type { UpgradeJob } from "../wire/types";
import type { HostdConfig } from "./config";
import { binaryPaths, CURRENT_RELEASE_LINK, RELEASE_BINARY_NAMES } from "./config";
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
    const binaries = binaryPaths(config);
    const [celld, caddy] = await Promise.all([versionOutput(binaries.celld, VERSION_ARGS.celld), versionOutput(binaries.caddy, VERSION_ARGS.caddy)]);

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

/** One component to install: where it goes, and the artifact that holds it. */
interface Install {
    artifact: HostdReleaseArtifact;
    component: "caddy" | "celld" | "hostd";
    target: string;
}

/** Download and check one component, and leave the binary at `install.target`. */
const stage = async (fetcher: typeof fetch, install: Install, progress: (line: string) => void): Promise<void> => {
    const downloaded = `${install.target}.download`;
    const staged = install.target;

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
};

const RELEASE_ID_PATTERN = /^[\w-]{1,128}$/u;

/** The release `{installDir}/current` points at, or `undefined` when there is none. */
const currentRelease = (installDirectory: string): string | undefined => {
    try {
        return basename(readlinkSync(join(installDirectory, CURRENT_RELEASE_LINK)));
    } catch {
        return undefined;
    }
};

/** Point `{installDir}/current` at `releaseId` in one rename, so it never dangles. */
const switchCurrent = (installDirectory: string, releaseId: string): void => {
    const next = join(installDirectory, `${CURRENT_RELEASE_LINK}.next`);

    rmSync(next, { force: true });
    symlinkSync(releaseId, next);
    renameSync(next, join(installDirectory, CURRENT_RELEASE_LINK));
};

/** Remove every installed release but `keep` — only directories that hold a `manifest.json`, so nothing else there is touched. */
const pruneReleases = (installDirectory: string, keep: ReadonlySet<string>): void => {
    for (const entry of readdirSync(installDirectory, { withFileTypes: true })) {
        if (
            entry.isDirectory() &&
            RELEASE_ID_PATTERN.test(entry.name) &&
            !keep.has(entry.name) &&
            existsSync(join(installDirectory, entry.name, "manifest.json"))
        ) {
            rmSync(join(installDirectory, entry.name), { force: true, recursive: true });
        }
    }
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

    const { installDir } = options.config;
    const running = currentRelease(installDir);

    if (running === manifest.releaseId) {
        progress(`release ${manifest.releaseId} is the one running; nothing to install`);

        return;
    }

    const target = join(installDir, manifest.releaseId);
    const staging = `${target}.partial`;
    const fetcher = options.fetch ?? globalThis.fetch;

    rmSync(staging, { force: true, recursive: true });
    mkdirSync(staging, { recursive: true });
    // Not left to the umask: the fleet user executes celld from here.
    chmodSync(staging, 0o755);

    try {
        for (const component of ["hostd", "celld", "caddy"] as const) {
            // eslint-disable-next-line no-await-in-loop -- one download at a time on a small box
            await stage(fetcher, { artifact: artifactOf(component), component, target: join(staging, RELEASE_BINARY_NAMES[component]) }, progress);
        }

        writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(verified.envelope)}\n`, { mode: 0o644 });
    } catch (error) {
        rmSync(staging, { force: true, recursive: true });
        throw error;
    }

    rmSync(target, { force: true, recursive: true });
    renameSync(staging, target);
    switchCurrent(installDir, manifest.releaseId);
    progress(`installed release ${manifest.releaseId} at ${target}; ${CURRENT_RELEASE_LINK} -> ${manifest.releaseId}`);
    pruneReleases(installDir, new Set([manifest.releaseId, ...(running === undefined ? [] : [running])]));

    if (manifest.hostd.version !== HOSTD_VERSION) {
        // The new lunora-hostd starts every child from current/ when systemd restarts it.
        progress(`lunora-hostd ${manifest.hostd.version} installed; restarting into it`);
        options.onSelfReplaced();

        return;
    }

    await options.supervisor.restartAll(progress);
};

export type { UpgradeOptions };
export { currentPlatform, currentRelease, installedVersions, runUpgrade, switchCurrent, versionToken };
