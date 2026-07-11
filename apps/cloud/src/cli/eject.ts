/**
 * `lunora eject` core (GAPS.md D2) — the no-lock-in exit hatch. Packages a
 * managed deployment for the BYO-account path: pulls the data snapshot through
 * the tenant's admin API (the framework's export RPC), scaffolds the
 * `wrangler.jsonc` the project would have had on BYO, and writes a step-by-step
 * README. Pure over injected ports (admin fetch + file writes), so the whole
 * flow unit-tests with fakes; the CLI wires the real I/O.
 */

export interface EjectTarget {
    /** Tenant admin bearer for the deployment's `/_lunora/admin/*` API. */
    adminToken: string;
    /** Platform apex the managed URL lives under (informational in the README). */
    appDomain: string;
    projectSlug: string;
    scriptName: string;
    /** The deployment's public base URL (`https://{script}.{appDomain}`). */
    url: string;
}

export interface EjectPorts {
    /** GET a tenant admin path (e.g. `/_lunora/admin/export`) and return the body text. */
    fetchAdmin: (url: string, path: string, adminToken: string) => Promise<string>;
    /** Persist one output file (CLI writes to `./eject/{name}`). */
    writeFile: (name: string, content: string) => Promise<void>;
}

/** The BYO `wrangler.jsonc` the project would have had outside the platform. */
export const buildByoWrangler = (target: Pick<EjectTarget, "projectSlug" | "scriptName">): string => {
    const config = {
        compatibility_date: "2026-07-01",
        d1_databases: [
            {
                binding: "GLOBAL_DB",
                database_id: "<create with: wrangler d1 create " + target.projectSlug + ">",
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

    return `${JSON.stringify(config, null, 4)}\n`;
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

export interface EjectResult {
    files: string[];
}

/** Run the eject: pull the snapshot, scaffold the BYO config, write the README. */
export const runEject = async (target: EjectTarget, ports: EjectPorts): Promise<EjectResult> => {
    const snapshot = await ports.fetchAdmin(target.url, "/_lunora/admin/export", target.adminToken);

    await ports.writeFile("export.ndjson", snapshot);
    await ports.writeFile("wrangler.jsonc", buildByoWrangler(target));
    await ports.writeFile("README.md", README(target));

    return { files: ["export.ndjson", "wrangler.jsonc", "README.md"] };
};
