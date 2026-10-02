/**
 * Installing a verified `lunora-hostd` release on the box (plan 458 W7,
 * protocol §8.3): the one implementation behind both the `upgrade` job and
 * `lunora-hostd install-release`, which `install.sh` runs.
 *
 * Releases live side by side:
 * `{installDir}/{releaseId}/{lunora-hostd,celld,caddy,manifest.json}`, with
 * `{installDir}/current` a symlink to the one that runs. The systemd unit
 * starts `current/lunora-hostd`, and every child is started from `current/`.
 *
 * Given a manifest whose signature the caller already verified, each artifact
 * for this platform is obtained into `{releaseId}.partial/` (downloaded by the
 * job, copied from what install.sh downloaded by the command), its size and
 * then its SHA-256 checked before it is decompressed, and it is run once
 * (`--version`) to prove it starts here. Nothing outside the staging
 * directory changes until all three passed. Then the directory is renamed
 * into place and `current` swapped to it in one rename. The release that ran
 * before stays, for a manual rollback (point `current` back at it); older
 * ones are removed. A release that already runs is left alone, and one whose
 * `lunora-hostd` is older than the installed one is refused unless the caller
 * explicitly allows a downgrade.
 */
import {
    chmodSync,
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type { HostdReleaseArtifact, HostdReleaseEnvelope, HostdReleasePlatform } from "../release";
import { compareReleaseVersions, releaseArtifactFor } from "../release-manifest";
import { verifyArtifact } from "../release-verify";
import HOSTD_VERSION from "../version";
import { DIRECT_LAUNCH } from "./capabilities";
import { runChild } from "./child";
import type { HostdConfig } from "./config";
import { binaryPaths, CURRENT_RELEASE_LINK, RELEASE_BINARY_NAMES } from "./config";
import { CHILD_PATH } from "./fleet-environment";
import { JobError } from "./job-error";

/** One binary of a release. */
type ReleaseComponent = keyof typeof RELEASE_BINARY_NAMES;

/** The components in the order they are installed. */
const RELEASE_COMPONENTS: ReadonlyArray<ReleaseComponent> = ["hostd", "celld", "caddy"];

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

/** `binary {args}`'s first output line, or `undefined` when it does not run (or exits non-zero, or hangs). */
const versionOutput = async (binary: string, args: ReadonlyArray<string>): Promise<string | undefined> => {
    try {
        const result = await runChild(DIRECT_LAUNCH, binary, args, { env: { PATH: CHILD_PATH }, timeoutMs: 10_000 });

        return result.code === 0 && !result.timedOut ? result.stdout.split("\n")[0]?.trim() : undefined;
    } catch {
        return undefined;
    }
};

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
const installedVersions = async (config: Pick<HostdConfig, "installDir">): Promise<{ caddy: string; celld: string; hostd: string }> => {
    const binaries = binaryPaths(config);
    const [celld, caddy] = await Promise.all([versionOutput(binaries.celld, VERSION_ARGS.celld), versionOutput(binaries.caddy, VERSION_ARGS.caddy)]);

    return { caddy: versionToken(caddy), celld: versionToken(celld), hostd: HOSTD_VERSION };
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

/** Put the bytes `artifact` pins (as published: compressed when it says so) at `path`. */
type ObtainArtifact = (component: ReleaseComponent, artifact: HostdReleaseArtifact, path: string) => Promise<void>;

/** Obtain, check, decompress and test-run one component, leaving the binary at `target`. */
const stage = async (
    component: ReleaseComponent,
    artifact: HostdReleaseArtifact,
    target: string,
    obtain: ObtainArtifact,
    progress: (line: string) => void,
): Promise<void> => {
    const downloaded = `${target}.download`;

    await obtain(component, artifact, downloaded);

    const checked = await verifyArtifact(downloaded, artifact.sha256, artifact.size);

    if (!checked.ok) {
        throw new JobError("ARTIFACT_INVALID", `${component}: ${checked.error.code}: ${checked.error.message}`);
    }

    if (artifact.compression === "gzip") {
        try {
            await pipeline(createReadStream(downloaded), createGunzip(), createWriteStream(target, { mode: 0o600 }));
        } catch (error) {
            throw new JobError("ARTIFACT_INVALID", `${component}: the manifest says gzip, but it does not decompress: ${(error as Error).message}`);
        }

        rmSync(downloaded, { force: true });
    } else {
        renameSync(downloaded, target);
    }

    chmodSync(target, 0o755);

    const printed = await versionOutput(target, VERSION_ARGS[component]);

    if (printed === undefined) {
        throw new JobError("ARTIFACT_INVALID", `${component} from ${artifact.url} does not run on this machine`);
    }

    progress(`${component} verified: ${printed}`);
};

interface InstallReleaseInput {
    /** Install a release whose `lunora-hostd` is older than the installed one. Off unless asked for explicitly. */
    allowDowngrade: boolean;
    /** A release envelope whose signature the caller verified against the compiled-in keys. */
    envelope: HostdReleaseEnvelope;
    installDir: string;
    obtain: ObtainArtifact;
    platform: HostdReleasePlatform;
    progress: (line: string) => void;
    /** The running `lunora-hostd`'s version, for when the installed release's manifest cannot be read. */
    runningVersion?: string;
}

/** The `lunora-hostd` version of the release `current` points at, from the manifest kept beside it. */
const installedHostdVersion = (installDirectory: string): string | undefined => {
    try {
        const kept = JSON.parse(readFileSync(join(installDirectory, CURRENT_RELEASE_LINK, "manifest.json"), "utf8")) as {
            manifest?: { hostd?: { version?: unknown } };
        };
        const version = kept.manifest?.hostd?.version;

        return typeof version === "string" ? version : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Anti-rollback: refuse a release whose `lunora-hostd` is older than the one
 * installed, unless the caller explicitly allows it. An older release is
 * still signed — the key cannot tell it from a new one — and installing it
 * would bring back whatever its successors fixed. A version that is not a
 * semantic version cannot be ordered, so it is refused too.
 * @throws {JobError} `UPGRADE_REFUSED`.
 */
const assertNotDowngrade = (candidate: string, installed: string | undefined, allowDowngrade: boolean): void => {
    if (installed === undefined || allowDowngrade) {
        return;
    }

    const order = compareReleaseVersions(candidate, installed);

    if (order === undefined) {
        throw new JobError(
            "UPGRADE_REFUSED",
            `cannot tell whether lunora-hostd ${candidate} is older than the installed ${installed} (not semantic versions); allow a downgrade to install it anyway`,
        );
    }

    if (order < 0) {
        throw new JobError(
            "UPGRADE_REFUSED",
            `lunora-hostd ${candidate} is older than the installed ${installed}: refusing a downgrade that was not explicitly allowed`,
        );
    }
};

/** What {@link installRelease} did. */
interface InstalledRelease {
    /** `false` when the release already ran: nothing changed. */
    installed: boolean;
    /** The release `current` pointed at before, kept for a rollback. */
    previous?: string;
}

/**
 * Install a verified release beside the running one and switch `current` to it.
 * @throws {JobError} `UPGRADE_REFUSED` for a downgrade not allowed or nothing for this platform, `FETCH_FAILED` / `ARTIFACT_INVALID` for an artifact. Nothing outside the staging directory has changed then.
 */
const installRelease = async (input: InstallReleaseInput): Promise<InstalledRelease> => {
    const { envelope, installDir, platform, progress } = input;
    const { manifest } = envelope;
    const running = currentRelease(installDir);

    if (running === manifest.releaseId) {
        progress(`release ${manifest.releaseId} is the one running; nothing to install`);

        return { installed: false, previous: running };
    }

    assertNotDowngrade(manifest.hostd.version, installedHostdVersion(installDir) ?? input.runningVersion, input.allowDowngrade);

    const artifacts = RELEASE_COMPONENTS.map((component) => {
        const artifact = releaseArtifactFor(manifest, component, platform);

        if (artifact === undefined) {
            throw new JobError("UPGRADE_REFUSED", `release ${manifest.releaseId} ships no ${component} for ${platform}`);
        }

        return [component, artifact] as const;
    });
    const target = join(installDir, manifest.releaseId);
    const staging = `${target}.partial`;

    rmSync(staging, { force: true, recursive: true });
    mkdirSync(staging, { recursive: true });
    // Not left to the umask: the fleet user executes celld from here.
    chmodSync(staging, 0o755);

    try {
        for (const [component, artifact] of artifacts) {
            // eslint-disable-next-line no-await-in-loop -- one download at a time on a small box
            await stage(component, artifact, join(staging, RELEASE_BINARY_NAMES[component]), input.obtain, progress);
        }

        writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(envelope)}\n`, { mode: 0o644 });
    } catch (error) {
        rmSync(staging, { force: true, recursive: true });
        throw error;
    }

    rmSync(target, { force: true, recursive: true });
    renameSync(staging, target);
    switchCurrent(installDir, manifest.releaseId);
    progress(`installed release ${manifest.releaseId} at ${target}; ${CURRENT_RELEASE_LINK} -> ${manifest.releaseId}`);
    pruneReleases(installDir, new Set([manifest.releaseId, ...(running === undefined ? [] : [running])]));

    return { installed: true, ...(running === undefined ? {} : { previous: running }) };
};

export type { InstalledRelease, InstallReleaseInput, ObtainArtifact, ReleaseComponent };
export {
    assertNotDowngrade,
    currentPlatform,
    currentRelease,
    installedHostdVersion,
    installedVersions,
    installRelease,
    pruneReleases,
    RELEASE_COMPONENTS,
    switchCurrent,
    versionOutput,
    versionToken,
};
