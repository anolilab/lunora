/**
 * `lunora cloud eject` core (GAPS.md D2) — the no-lock-in exit hatch. Packages a
 * managed deployment for the BYO-account path: takes the data snapshot the
 * control plane pulled from the tenant's admin API, scaffolds the
 * `wrangler.jsonc` the project would have had on BYO, and writes a step-by-step
 * README.
 *
 * Lives in the CLI, not the control plane, because the output is FILES ON THE
 * USER'S DISK — the templates belong on the side that writes them. The control
 * plane's job is narrower: authorize the deploy key and hand back the snapshot
 * plus the identity the config is named after (`POST /v1/eject`).
 *
 * Pure over an injected write port, so the whole flow unit-tests with fakes.
 */

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

interface EjectPorts {
    /** Fetch the package from the control plane's `/v1/eject` (deploy-key authorized). */
    fetchPackage: () => Promise<EjectTarget & { snapshot: string }>;
    /** Persist one output file (the CLI writes to `./eject/{name}`). */
    writeFile: (name: string, content: string) => Promise<void>;
}

/** The BYO `wrangler.jsonc` the project would have had outside the platform. */
const buildByoWrangler = (target: Pick<EjectTarget, "projectSlug" | "scriptName">): string => {
    const config = {
        compatibility_date: "2026-07-01",
        d1_databases: [
            {
                binding: "GLOBAL_DB",
                database_id: `<create with: wrangler d1 create ${target.projectSlug}>`,
                database_name: target.projectSlug,
            },
        ],
        durable_objects: {
            bindings: [
                { class_name: "ShardDO", name: "SHARD" },
                { class_name: "SessionDO", name: "SESSION" },
            ],
        },
        main: "dist/worker.js",
        migrations: [{ new_sqlite_classes: ["ShardDO", "SessionDO"], tag: "v1" }],
        name: target.scriptName,
        observability: { enabled: true },
    };

    return `${JSON.stringify(config, undefined, 4)}\n`;
};

const README = (target: EjectTarget): string => `# Ejected: ${target.projectSlug}

Your data and config, packaged for your own Cloudflare account — the managed
platform holds nothing back.

## What's here

- \`wrangler.jsonc\` — the config your project uses on the BYO path.
- \`export.ndjson\` — your full data snapshot (shards + global tables).

## Restore on your own account

1. \`wrangler d1 create ${target.projectSlug}\` and paste the id into \`wrangler.jsonc\`.
2. Build your app (\`lunora build\`) and \`wrangler deploy\`.
3. Import the snapshot: \`lunora import export.ndjson\` against your deployment.

Your managed deployment at ${target.url} keeps serving until you delete it.
`;

interface EjectResult {
    files: string[];
}

/**
 * Run the eject: pull the package, scaffold the BYO config, write the README.
 *
 * The fetch happens before any write, so a failed export leaves no half-written
 * directory for someone to mistake for a complete backup.
 */
const runEject = async (ports: EjectPorts): Promise<EjectResult> => {
    const { snapshot, ...target } = await ports.fetchPackage();

    await ports.writeFile("export.ndjson", snapshot);
    await ports.writeFile("wrangler.jsonc", buildByoWrangler(target));
    await ports.writeFile("README.md", README(target));

    return { files: ["export.ndjson", "wrangler.jsonc", "README.md"] };
};

export { buildByoWrangler, runEject };
export type { EjectPorts, EjectResult, EjectTarget };
