/**
 * `lunora-hostd enrol` (plan 458 D4, W4 "Enrol"): bind this machine to an
 * organization with the one-time token the studio showed.
 *
 * In order: check the bucket with celld's own probe (so a wrong bucket fails
 * before the single-use token is spent), generate the box's Ed25519 key,
 * `POST /v1/boxes/enrol` with the token, the public key, the box's public
 * addresses and its binaries' versions, then write the configuration and the
 * bucket credentials (mode 0600). The token is sent once and never printed;
 * the bucket credentials are read from the environment, never from the
 * command line, and never leave the box.
 */
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import { celldDiagnose } from "./celld-cli";
import type { HostdConfig } from "./config";
import { ConfigError, CREDENTIAL_NAMES, DEFAULT_DATA_DIR, DEFAULT_PORTS, parseHostdConfig, saveBucketCredentials, saveHostdConfig } from "./config";
import { generateIdentity } from "./identity";
import type { Logger } from "./log";
import { installedVersions } from "./upgrade";

/** The production control plane `enrol` uses without `--control-plane` — none is published yet (plan 458 D16). */
const DEFAULT_CONTROL_PLANE: string | undefined = undefined;

interface EnrolInput {
    bucket: string;
    /** Run the bucket probe; on by default, off only where celld is not installed yet. */
    checkBucket: boolean;
    configPath: string;
    controlPlane?: string;
    dataDir?: string;
    endpoint?: string;
    /** Overwrite an existing enrolment. */
    force: boolean;
    ipv4?: string;
    ipv6?: string;
    region?: string;
    singleTrust: boolean;
    token: string;
}

interface EnrolDependencies {
    environment: NodeJS.ProcessEnv;
    /** Injected for tests. */
    fetch?: typeof fetch;
    /** Injected for tests: the machine's addresses. */
    interfaces?: () => ReturnType<typeof networkInterfaces>;
    logger: Logger;
}

const isPrivateIpv4 = (address: string): boolean => {
    const [a = 0, b = 0] = address.split(".").map(Number);

    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127)
    );
};

const GLOBAL_IPV6_PATTERN = /^[23][\da-f]{0,3}:/iu;

/** Global unicast (2000::/3), which the control plane requires. */
const isGlobalIpv6 = (address: string): boolean => GLOBAL_IPV6_PATTERN.test(address);

/** The machine's first public IPv4 and global IPv6 address, as the control plane points the box's hostnames at them. */
const publicAddresses = (interfaces: ReturnType<typeof networkInterfaces>): { ipv4?: string; ipv6?: string } => {
    const all = Object.values(interfaces).flatMap((entries) => entries ?? []);
    const ipv4 = all.find((entry) => entry.family === "IPv4" && !entry.internal && !isPrivateIpv4(entry.address))?.address;
    const ipv6 = all.find((entry) => entry.family === "IPv6" && !entry.internal && isGlobalIpv6(entry.address))?.address;

    return { ...(ipv4 === undefined ? {} : { ipv4 }), ...(ipv6 === undefined ? {} : { ipv6 }) };
};

/** A bucket given as `name` or `s3://name`. Other schemes are not supported on a box yet. */
const bucketNameOf = (bucket: string): string => {
    let name = bucket.startsWith("s3://") ? bucket.slice("s3://".length) : bucket;

    while (name.endsWith("/")) {
        name = name.slice(0, -1);
    }

    if (name === "" || name.includes("/") || name.includes("://")) {
        throw new ConfigError("--bucket must be a bucket name or s3://{name}: each fleet gets its own prefix in it");
    }

    return name;
};

interface EnrolResponse {
    boxId: string;
    dnsError?: string;
    hostname: string;
}

/** Run celld's own bucket probe; throws (before the token is spent) when a bucket check fails. */
const checkBucket = async (draft: HostdConfig, credentials: Readonly<Record<string, string>>, logger: Logger): Promise<void> => {
    logger.info(`checking s3://${draft.bucket.name} with celld diagnose`);

    const probe = await celldDiagnose(draft, "_hostd-enrol-check", credentials);
    const bucketChecks = probe.lines.filter((line) => line.includes('"check":"bucket'));

    if (bucketChecks.length === 0 || bucketChecks.some((line) => !line.includes('"verdict":"ok"'))) {
        throw new ConfigError(`the bucket check failed, so the enrolment token was not used:\n${probe.lines.join("\n")}`);
    }
};

/** Why the control plane refused, from its `{error}` (or `{message}`) body. */
const refusalReason = (body: { error?: unknown; message?: unknown }): string => {
    if (typeof body.message === "string") {
        return body.message;
    }

    return typeof body.error === "string" ? body.error : "no reason given";
};

/** `POST /v1/boxes/enrol`; the box's id and hostname, or a refusal. The token is in the body only. */
const requestEnrolment = async (controlPlane: string, payload: Record<string, unknown>, fetcher: typeof fetch): Promise<EnrolResponse> => {
    const response = await fetcher(new URL("/v1/boxes/enrol", controlPlane), {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => {
        return {};
    })) as Partial<EnrolResponse> & { error?: unknown; message?: unknown };

    if (!response.ok || typeof body.boxId !== "string" || typeof body.hostname !== "string") {
        throw new ConfigError(`the control plane refused the enrolment (${String(response.status)}): ${refusalReason(body)}`);
    }

    return { boxId: body.boxId, hostname: body.hostname, ...(typeof body.dnsError === "string" ? { dnsError: body.dnsError } : {}) };
};

/** The configuration an enrolment writes, validated (and defaulted) before anything is written or sent. */
const draftConfig = (input: EnrolInput, controlPlane: string): HostdConfig => {
    const configDirectory = dirname(input.configPath);

    return parseHostdConfig({
        boxId: "pending",
        bucket: {
            name: bucketNameOf(input.bucket),
            ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
            ...(input.region === undefined ? {} : { region: input.region }),
        },
        controlPlane: new URL(controlPlane).origin,
        credentialsFile: join(configDirectory, "bucket.env"),
        dataDir: input.dataDir ?? DEFAULT_DATA_DIR,
        hostname: "pending",
        keyFile: join(configDirectory, "box.key"),
        ports: DEFAULT_PORTS,
        singleTrust: input.singleTrust,
    });
};

/**
 * Enrol this machine.
 * @returns the written configuration
 * @throws {ConfigError} for a bad flag, a failed bucket check or a refused enrolment.
 */
const enrol = async (input: EnrolInput, dependencies: EnrolDependencies): Promise<HostdConfig> => {
    const controlPlane = input.controlPlane ?? DEFAULT_CONTROL_PLANE;

    if (controlPlane === undefined) {
        throw new ConfigError("no default control plane is configured in this build; pass --control-plane {origin}");
    }

    if (existsSync(input.configPath) && !input.force) {
        throw new ConfigError(`${input.configPath} exists: this machine is enrolled already. Enrolling again creates a new box; pass --force to do that`);
    }

    const draft = draftConfig(input, controlPlane);
    const credentials = Object.fromEntries(
        CREDENTIAL_NAMES.flatMap((name) => {
            const value = dependencies.environment[name];

            return value === undefined ? [] : [[name, value]];
        }),
    );

    if (input.checkBucket) {
        await checkBucket(draft, credentials, dependencies.logger);
    }

    const addresses = {
        ...publicAddresses((dependencies.interfaces ?? networkInterfaces)()),
        ...(input.ipv4 === undefined ? {} : { ipv4: input.ipv4 }),
        ...(input.ipv6 === undefined ? {} : { ipv6: input.ipv6 }),
    };

    if (addresses.ipv4 === undefined && addresses.ipv6 === undefined) {
        throw new ConfigError("found no public IPv4 or IPv6 address on this machine; pass --ipv4 or --ipv6 with the address its hostnames should point at");
    }

    const identity = generateIdentity(draft.keyFile);
    const versions = await installedVersions(draft);
    const enrolled = await requestEnrolment(
        draft.controlPlane,
        { ...addresses, publicKey: identity.publicKey, singleTrust: input.singleTrust, token: input.token, versions },
        dependencies.fetch ?? globalThis.fetch,
    );
    const config = parseHostdConfig({ ...draft, boxId: enrolled.boxId, hostname: enrolled.hostname });

    saveBucketCredentials(config.credentialsFile, credentials);
    saveHostdConfig(input.configPath, config);
    dependencies.logger.info(`enrolled as box ${config.boxId} (${config.hostname})`);

    if (enrolled.dnsError !== undefined) {
        dependencies.logger.warn(`the control plane could not write this box's DNS records yet: ${enrolled.dnsError}`);
    }

    return config;
};

export type { EnrolDependencies, EnrolInput };
export { DEFAULT_CONTROL_PLANE, enrol, publicAddresses };
