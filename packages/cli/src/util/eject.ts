/**
 * `lunora cloud eject` core (GAPS.md D2) — the no-lock-in exit hatch. Packages a
 * managed deployment for the BYO-account path: takes the data snapshot the
 * control plane pulled from the tenant's admin API, derives a BYO
 * `wrangler.jsonc` and an Alchemy 2 program from the project's own wrangler
 * config, and writes a step-by-step README.
 *
 * Lives in the CLI, not the control plane, because the output is FILES ON THE
 * USER'S DISK — and the project's config is on that disk too, so the ejected
 * config carries every binding the app actually uses rather than a template.
 * The control plane's job is narrower: authorize the deploy key and hand back
 * the snapshot plus the identity the config is named after (`POST /v1/eject`).
 *
 * Two deploy tools, one config: the platform provisions with Alchemy 2, so the
 * emitted `alchemy.run.ts` speaks the same resource model, and `wrangler.jsonc`
 * serves whoever would rather not adopt it.
 *
 * Pure over an injected write port, so the whole flow unit-tests with fakes.
 */
import type { WranglerConfigShape } from "@lunora/config/cloudflare";
import { wranglerToAlchemy } from "@lunora/config/cloudflare";
import { isAbsolute, join } from "@visulima/path";

/**
 * What `POST /v1/eject` hands back: the snapshot plus the identity the scaffolded
 * config is named after.
 *
 * Note what is NOT here — the tenant's admin token. The control plane unseals it,
 * uses it, and keeps it; the CLI only ever sees the resulting bytes. So ejecting
 * never puts a long-lived tenant bearer on a developer's disk or in their shell
 * history, which would be a poor trade for an exit hatch.
 */
interface EjectTarget {
    projectSlug: string;
    scriptName: string;
    /** The deployment's public base URL — informational, for the README. */
    url: string;
}

interface EjectProject {
    /** The project's own parsed wrangler config — every section, not only the modelled ones. */
    config: WranglerConfigShape;
    /** The config file's directory, relative to the eject output directory — its relative paths are rebased onto it. */
    configDirectory: string;
}

interface EjectPorts {
    /** Fetch the package from the control plane's `/v1/eject` (deploy-key authorized). */
    fetchPackage: () => Promise<EjectTarget & { snapshot: string }>;
    /** The output directory as the README should name it, relative to the project directory. */
    outputDirectory: string;
    project: EjectProject;
    /** Persist one output file (the CLI writes to `./eject/{name}`). */
    writeFile: (name: string, content: string) => Promise<void>;
}

/**
 * Replace the ids that name resources in the account the config was written for
 * — they mean nothing in the account being ejected to — with the command that
 * creates the replacement. Names (buckets, queues, database names) carry over:
 * they are what gets created.
 */
/** Per section: the id field, the preview id to drop, and the command that mints a new id. */
const ID_PLACEHOLDERS: ReadonlyArray<{ command: (entry: Record<string, string | undefined>) => string; drop?: string; idKey: string; section: string }> = [
    {
        command: (d1) => `wrangler d1 create ${d1["database_name"] ?? d1["binding"] ?? ""}`,
        drop: "preview_database_id",
        idKey: "database_id",
        section: "d1_databases",
    },
    { command: (kv) => `wrangler kv namespace create ${kv["binding"] ?? ""}`, drop: "preview_id", idKey: "id", section: "kv_namespaces" },
    {
        command: (hyperdrive) => `wrangler hyperdrive create ${hyperdrive["binding"] ?? ""} --connection-string=<your database url>`,
        idKey: "id",
        section: "hyperdrive",
    },
];

const scrubIds = (config: Record<string, unknown>): Record<string, unknown> => {
    const scrubbed = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "account_id"));

    for (const { command, drop, idKey, section } of ID_PLACEHOLDERS) {
        const entries = scrubbed[section];

        if (Array.isArray(entries)) {
            scrubbed[section] = entries.map((entry: Record<string, string | undefined>) => {
                return {
                    ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== drop)),
                    [idKey]: `<create with: ${command(entry)}>`,
                };
            });
        }
    }

    return scrubbed;
};

/**
 * The project's config, ready for another account: ids replaced, named after the
 * deployment's script, and — per wrangler environment too — nothing pointing at
 * the old account.
 */
const byoConfig = (project: WranglerConfigShape, target: Pick<EjectTarget, "scriptName">): WranglerConfigShape => {
    const config = scrubIds({ ...(structuredClone(project) as Record<string, unknown>), name: target.scriptName });
    const environments = config["env"];

    if (typeof environments === "object" && environments !== null) {
        config["env"] = Object.fromEntries(
            Object.entries(environments as Record<string, Record<string, unknown>>).map(([name, environment]) => [name, scrubIds(environment)]),
        );
    }

    return config;
};

/** Wrangler resolves `main` and `assets.directory` against the config file, which now lives in the eject directory. */
const rebasePaths = (config: WranglerConfigShape, configDirectory: string): WranglerConfigShape => {
    const rebase = (path: string | undefined): string | undefined => (path === undefined || isAbsolute(path) ? path : join(configDirectory, path));

    return {
        ...config,
        ...(config.main === undefined ? {} : { main: rebase(config.main) }),
        ...(config.assets?.directory === undefined ? {} : { assets: { ...config.assets, directory: rebase(config.assets.directory) } }),
    };
};

/** One `wrangler … create` line per resource the BYO account needs before `wrangler deploy`. */
const createCommands = (config: WranglerConfigShape): string[] => [
    ...(config.d1_databases ?? []).map((d1) => `wrangler d1 create ${d1.database_name ?? d1.binding ?? ""}`),
    ...(config.kv_namespaces ?? []).map((kv) => `wrangler kv namespace create ${kv.binding ?? ""}`),
    ...(config.r2_buckets ?? []).map((r2) => `wrangler r2 bucket create ${r2.bucket_name ?? r2.binding ?? ""}`),
    ...[...new Set([...(config.queues?.producers ?? []), ...(config.queues?.consumers ?? [])].map((queue) => queue.queue))]
        .filter((queue): queue is string => queue !== undefined)
        .map((queue) => `wrangler queues create ${queue}`),
    ...(config.vectorize ?? []).map((index) => `wrangler vectorize create ${index.index_name ?? index.binding ?? ""} --dimensions=<n> --metric=cosine`),
    ...(config.hyperdrive ?? []).map((hyperdrive) => `wrangler hyperdrive create ${hyperdrive.binding ?? ""} --connection-string=<your database url>`),
];

const README = (target: EjectTarget, config: WranglerConfigShape, unsupported: ReadonlyArray<string>, outputDirectory: string): string => {
    const commands = createCommands(config);
    const creates =
        commands.length === 0
            ? "1. Nothing to create up front — the config has no provisioned resources."
            : `1. Create the resources, pasting each printed id over its \`<create with: …>\` placeholder:\n\n   \`\`\`bash\n${commands.map((command) => `   ${command}`).join("\n")}\n   \`\`\``;
    const gaps =
        unsupported.length === 0
            ? ""
            : `\nThe Alchemy program does not carry these sections — bind them by hand, or use the wrangler path:\n\n${unsupported.map((entry) => `- ${entry}`).join("\n")}\n`;

    return `# Ejected: ${target.projectSlug}

Your data and config, packaged for your own Cloudflare account — the managed
platform holds nothing back.

## What's here

- \`alchemy.run.ts\` — an [Alchemy 2](https://alchemy.run) program for your app, the
  same tool Lunora Cloud provisions with. Generated from your \`wrangler.jsonc\`.
- \`wrangler.jsonc\` — your project's config with the old account's ids replaced
  by \`<create with: …>\` placeholders.
- \`export.ndjson\` — your full data snapshot (shards + global tables).

Pick one of the two deploy paths below.

## Deploy with Alchemy

Alchemy creates every resource itself; there are no ids to paste. Run it from the
project directory (where your \`wrangler.jsonc\` is), after \`lunora build\`, with
\`CLOUDFLARE_ACCOUNT_ID\` and \`CLOUDFLARE_API_TOKEN\` set for your account:

\`\`\`bash
npm install -D @effect/platform-node@4.0.0-rc.117 alchemy@2.0.0-beta.79 effect@4.0.0-rc.117
npx alchemy deploy ${outputDirectory}/alchemy.run.ts --stage production
\`\`\`

State is written to \`.alchemy/\` in that directory. Keep it: it is how the next
deploy knows what it already created. Swap \`localState()\` for
\`Cloudflare.state()\` in the program to keep it in your account instead.
${gaps}
## Deploy with wrangler

${creates}
2. Build your app (\`lunora build\`) and \`wrangler deploy -c ${outputDirectory}/wrangler.jsonc\`.

## Restore your data

Import the snapshot: \`lunora import ${outputDirectory}/export.ndjson\` against your new deployment.

Your managed deployment at ${target.url} keeps serving until you delete it.
`;
};

interface EjectResult {
    files: string[];
    /** Wrangler sections the Alchemy program could not carry, so the caller can warn. */
    unsupported: ReadonlyArray<string>;
}

/**
 * Run the eject: pull the package, derive the BYO config and the Alchemy
 * program from the project's own config, write the README.
 *
 * The fetch happens before any write, so a failed export leaves no half-written
 * directory for someone to mistake for a complete backup.
 */
const runEject = async (ports: EjectPorts): Promise<EjectResult> => {
    const { snapshot, ...target } = await ports.fetchPackage();
    const config = byoConfig(ports.project.config, target);
    // Alchemy resolves paths against the working directory, which the README
    // says is the project directory — so the program keeps the config's own
    // paths, and only the relocated wrangler file is rebased.
    const { source, unsupported } = wranglerToAlchemy(config);

    await ports.writeFile("export.ndjson", snapshot);
    await ports.writeFile("wrangler.jsonc", `${JSON.stringify(rebasePaths(config, ports.project.configDirectory), undefined, 4)}\n`);
    await ports.writeFile("alchemy.run.ts", source);
    await ports.writeFile("README.md", README(target, config, unsupported, ports.outputDirectory));

    return { files: ["export.ndjson", "wrangler.jsonc", "alchemy.run.ts", "README.md"], unsupported };
};

export { byoConfig, runEject };
export type { EjectPorts, EjectProject, EjectResult, EjectTarget };
