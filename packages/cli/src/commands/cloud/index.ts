import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora cloud <subcommand>` — ship to the managed Lunora Cloud control plane
 * from the one `lunora` binary (the sibling of the self-host `deploy` /
 * `deployments` wrangler flow). Authenticates with an org **deploy key** read
 * from `LUNORA_DEPLOY_KEY` (never a flag or a file — it is a secret).
 */
const cloudCommand: Command = {
    argument: { description: "deploy | rollback <deployment-id>", name: "subcommand", type: String },
    description: "Deploy / roll back on the managed Lunora Cloud (auth: LUNORA_DEPLOY_KEY)",
    examples: [
        ["LUNORA_DEPLOY_KEY=… lunora cloud deploy --project prj_123 --bundle dist/index.js", "Deploy the prebuilt worker"],
        ["lunora cloud deploy --project prj_123 --bundle dist/index.js --kind preview --branch feat/x", "Deploy a preview"],
        ["lunora cloud rollback dep_456 --org org_789 --yes", "Roll the stable URL back to a retained release"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "cloud",
    options: [
        { description: "Managed-cloud API URL (or set LUNORA_CLOUD_URL)", name: "url", type: String },
        { description: "Target project id (deploy)", name: "project", type: String },
        { description: "Path to the prebuilt worker bundle to upload (deploy)", name: "bundle", type: String },
        { description: "Worker/script name; defaults to the wrangler config `name` (deploy)", name: "name", type: String },
        { description: "Deployment kind: production | preview | dev (deploy)", name: "kind", type: String },
        { description: "Originating git branch to record (deploy)", name: "branch", type: String },
        { description: "Organization id (rollback)", name: "org", type: String },
        { description: "Confirm a rollback (it shifts live traffic)", name: "yes", type: Boolean },
    ],
};

export { cloudCommand };

export type CloudOptions = CreateOptions<{
    branch: string | undefined;
    bundle: string | undefined;
    kind: string | undefined;
    name: string | undefined;
    org: string | undefined;
    project: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
