import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, configPathOf, DEFAULT_INSTALL_DIR, loadHostdConfig, RELEASE_BINARY_NAMES } from "./daemon/config";
import { enrol } from "./daemon/enrol";
import { createLogger } from "./daemon/log";
import { currentPlatform, installRelease } from "./daemon/release-install";
import type { DaemonOptions } from "./daemon/run";
import { Daemon, statusText } from "./daemon/run";
import type { TrustedReleaseKey } from "./release";
import { HOSTD_TRUSTED_RELEASE_KEYS, verifyReleaseManifest } from "./release";
import { isReleasePlatform } from "./release-manifest";
import { optional } from "./values";
import HOSTD_VERSION from "./version";

/** Where the binary writes; injected so tests need no real process streams. */
interface BinOutput {
    stderr: (text: string) => void;
    stdout: (text: string) => void;
}

/** What the commands reach outside their arguments; injected for tests. */
interface BinDependencies {
    /** Overrides for the daemon (a fake socket, fake fetch). */
    daemon?: Partial<Omit<DaemonOptions, "config" | "logger">>;
    environment?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    /** Register a handler for SIGTERM/SIGINT; the real binary uses `process.once`. */
    onSignal?: (handler: () => void) => void;
    /** The release keys `install-release` trusts: the compiled-in set unless a test injects its own. */
    trustedKeys?: Readonly<Record<string, TrustedReleaseKey>>;
}

const HELP = `lunora-hostd — runs Lunora Cloud fleets on your own server.

Usage:
  lunora-hostd enrol --bucket <name> [options]
      Bind this machine to your organization with the one-time token the
      studio shows, read from LUNORA_HOSTD_ENROL_TOKEN (install.sh asks for
      it and passes it on so). Options:
        --control-plane <origin>   Lunora Cloud's origin
        --bucket <name|s3://name>  the bucket your fleets' data lives in
        --endpoint <url>           S3-compatible endpoint (R2, Tigris, MinIO…)
        --region <region>          bucket region
        --ipv4 <address>           public address (detected when omitted)
        --ipv6 <address>
        --single-trust             run fleets without the isolation self-check
        --data-dir <path>          default /var/lib/lunora-hostd
        --install-dir <path>       where install.sh put the releases,
                                   default /opt/lunora-hostd
        --force                    enrol again as a new box
        --skip-bucket-check        do not probe the bucket with celld first
      The bucket credentials come from AWS_ACCESS_KEY_ID /
      AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN) in the environment; they are
      written to a file only this box can read and never sent to Lunora
      Cloud. No secret is ever taken from the command line.
  lunora-hostd run         Run the daemon in the foreground (systemd runs this)
  lunora-hostd status      Show this box's enrolment and fleets
  lunora-hostd install-release <manifest.json> --from <directory>
               [--install-dir <path>] [--platform <p>] [--allow-downgrade]
      Install the release a manifest describes from the files downloaded
      into <directory> (lunora-hostd, celld, caddy, as published), exactly
      as an upgrade does: verify the manifest against the release keys
      compiled into this binary, check each file against the size and
      SHA-256 it pins for this platform (linux-x64 or linux-arm64), run it
      once, then install it beside the running release and switch current
      to it. A release older than the installed one is refused without
      --allow-downgrade. Prints the release id. install.sh runs it.
  lunora-hostd --version   Print the version
  lunora-hostd --help      Print this help

Every command takes --config <path> (default /etc/lunora-hostd/config.json,
or LUNORA_HOSTD_CONFIG).
`;

const ENROL_OPTIONS = {
    bucket: { type: "string" },
    config: { type: "string" },
    "control-plane": { type: "string" },
    "data-dir": { type: "string" },
    endpoint: { type: "string" },
    force: { type: "boolean" },
    "install-dir": { type: "string" },
    ipv4: { type: "string" },
    ipv6: { type: "string" },
    region: { type: "string" },
    "single-trust": { type: "boolean" },
    "skip-bucket-check": { type: "boolean" },
    token: { type: "string" },
} as const;

const CONFIG_ONLY = { config: { type: "string" } } as const;

const INSTALL_OPTIONS = {
    "allow-downgrade": { type: "boolean" },
    from: { type: "string" },
    "install-dir": { type: "string" },
    platform: { type: "string" },
} as const;

const runEnrol = async (args: ReadonlyArray<string>, output: BinOutput, dependencies: BinDependencies): Promise<number> => {
    const environment = dependencies.environment ?? process.env;
    const { values } = parseArgs({ args: [...args], options: ENROL_OPTIONS, strict: true });
    const token = environment["LUNORA_HOSTD_ENROL_TOKEN"];

    if (values.token !== undefined) {
        // Never echoed: it is the token.
        output.stderr("lunora-hostd enrol takes the token from LUNORA_HOSTD_ENROL_TOKEN, not --token, which would leave it in shell history and ps\n");

        return 1;
    }

    if (token === undefined || token === "" || values.bucket === undefined) {
        output.stderr("lunora-hostd enrol needs LUNORA_HOSTD_ENROL_TOKEN in its environment, and --bucket\n");

        return 1;
    }

    await enrol(
        {
            bucket: values.bucket,
            checkBucket: values["skip-bucket-check"] !== true,
            configPath: configPathOf(values.config, environment),
            ...optional("controlPlane", values["control-plane"]),
            ...optional("dataDir", values["data-dir"]),
            ...optional("endpoint", values.endpoint),
            force: values.force === true,
            ...optional("installDir", values["install-dir"]),
            ...optional("ipv4", values.ipv4),
            ...optional("ipv6", values.ipv6),
            ...optional("region", values.region),
            singleTrust: values["single-trust"] === true,
            token,
        },
        { environment, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }), logger: createLogger(output.stderr) },
    );

    return 0;
};

const runDaemon = async (args: ReadonlyArray<string>, output: BinOutput, dependencies: BinDependencies): Promise<number> => {
    const { values } = parseArgs({ args: [...args], options: CONFIG_ONLY, strict: true });
    const config = loadHostdConfig(configPathOf(values.config, dependencies.environment ?? process.env));
    const daemon = new Daemon({
        config,
        logger: createLogger(output.stderr),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...dependencies.daemon,
    });
    const onSignal =
        dependencies.onSignal ??
        ((handler: () => void) => {
            process.once("SIGTERM", handler);
            process.once("SIGINT", handler);
        });

    onSignal(() => {
        daemon.stop();
    });

    return daemon.run();
};

/**
 * `install-release`: install a release `install.sh` downloaded, exactly as the
 * `upgrade` job installs one. install.sh trusts this binary only because its
 * bytes matched the manifest it had verified with OpenSSL; the binary then
 * verifies the manifest again, strictly, with its compiled-in keys, and checks
 * every file against it before anything is installed.
 */
const runInstallRelease = async (args: ReadonlyArray<string>, output: BinOutput, dependencies: BinDependencies): Promise<number> => {
    const { positionals, values } = parseArgs({ allowPositionals: true, args: [...args], options: INSTALL_OPTIONS, strict: true });
    const [manifestPath] = positionals;
    const platform = values.platform ?? currentPlatform();

    if (manifestPath === undefined || positionals.length !== 1 || values.from === undefined || platform === undefined || !isReleasePlatform(platform)) {
        output.stderr("lunora-hostd install-release needs one manifest file and --from <directory>, on linux-x64 or linux-arm64 (or --platform)\n");

        return 1;
    }

    let envelope: unknown;

    try {
        envelope = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
        output.stderr(`lunora-hostd: ${manifestPath} is not a readable JSON file\n`);

        return 1;
    }

    const verified = await verifyReleaseManifest(envelope, dependencies.trustedKeys ?? HOSTD_TRUSTED_RELEASE_KEYS);

    if (!verified.ok) {
        output.stderr(`lunora-hostd: the release manifest does not verify: ${verified.error.code}: ${verified.error.message}\n`);

        return 1;
    }

    const { from } = values;

    await installRelease({
        allowDowngrade: values["allow-downgrade"] === true,
        envelope: verified.envelope,
        installDir: values["install-dir"] ?? DEFAULT_INSTALL_DIR,
        // What install.sh downloaded, named after the binary it holds (compressed when the manifest says so).
        obtain: async (component, _artifact, path) => {
            await copyFile(join(from, RELEASE_BINARY_NAMES[component]), path);
        },
        platform,
        progress: (line) => {
            output.stderr(`lunora-hostd: ${line}\n`);
        },
    });
    output.stdout(`${verified.envelope.manifest.releaseId}\n`);

    return 0;
};

const runStatus = (args: ReadonlyArray<string>, output: BinOutput, dependencies: BinDependencies): number => {
    const { values } = parseArgs({ args: [...args], options: CONFIG_ONLY, strict: true });

    output.stdout(statusText(loadHostdConfig(configPathOf(values.config, dependencies.environment ?? process.env))));

    return 0;
};

/**
 * Run `lunora-hostd` with the arguments after the executable and script.
 * Arguments are never echoed back: one might be a secret pasted in the wrong place.
 * @returns the process exit code
 */
const runBin = async (argv: ReadonlyArray<string>, output: BinOutput, dependencies: BinDependencies = {}): Promise<number> => {
    const [command, ...rest] = argv;

    if (argv.length === 1 && (command === "--version" || command === "-v")) {
        output.stdout(`${HOSTD_VERSION}\n`);

        return 0;
    }

    if (argv.length === 1 && (command === "--help" || command === "-h")) {
        output.stdout(HELP);

        return 0;
    }

    try {
        switch (command) {
            case "enrol": {
                return await runEnrol(rest, output, dependencies);
            }
            case "install-release": {
                return await runInstallRelease(rest, output, dependencies);
            }
            case "run": {
                return await runDaemon(rest, output, dependencies);
            }
            case "status": {
                return runStatus(rest, output, dependencies);
            }
            default: {
                output.stderr(HELP);

                return 1;
            }
        }
    } catch (error) {
        if (error instanceof ConfigError) {
            output.stderr(`lunora-hostd: ${error.message}\n`);

            return 1;
        }

        // parseArgs names the bad option, but an unexpected positional would be echoed — and might be the token.
        if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
            output.stderr(`lunora-hostd: invalid arguments for ${command ?? ""}; see lunora-hostd --help\n`);

            return 1;
        }

        output.stderr(`lunora-hostd: ${error instanceof Error ? error.message : String(error)}\n`);

        return 1;
    }
};

export type { BinDependencies, BinOutput };
export { runBin };
