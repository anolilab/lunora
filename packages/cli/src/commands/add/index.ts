import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora add &lt;feature>` — add a feature or registry item to an existing
 * project. A thin, discoverable front door over `lunora registry add`: the
 * friendly aliases (`auth` asks which provider, `email`/`mail` → the mail item)
 * resolve to registry item(s); any other name is passed straight to the
 * registry (e.g. `ai`, `storage`, `crons`, `presence`, `queue`, `backup`,
 * `flags`, `workflow`, `auth-clerk`). One install path behind every front door.
 */
const addCommand: Command = {
    argument: {
        description: "Feature or registry item: ai | auth | email | storage | crons | presence | queue | workflow | flags | backup | …",
        name: "feature",
        type: String,
    },
    description: "Add a feature or registry item (ai, auth, email, storage, crons, …) to the current Lunora project",
    examples: [
        ["lunora add auth", "Add authentication (asks which provider)"],
        ["lunora add auth --provider clerk", "Add Clerk auth without prompting"],
        ["lunora add auth-ui", "Add copy-in auth screens for your framework (auto-detected)"],
        ["lunora add email", "Add transactional email (Cloudflare Email Workers + dev mail catcher)"],
        ["lunora add storage", "Add the R2 storage registry item (asks for the bucket name)"],
        ["lunora add storage --bucket my-app-uploads", "Add storage with a bucket name, no prompt"],
        ["lunora add crons", "Add the scheduled-jobs registry item"],
        ["lunora add storage --ref alpha", "Add an item from the alpha branch's registry"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "add",
    options: [
        { description: "auth: provider to use without prompting (auth | clerk | auth0)", name: "provider", type: String },
        { description: "auth: D1 database name to use without prompting (lowercase alphanumeric + hyphens)", name: "db", type: String },
        { description: "storage: R2 bucket name to use without prompting (lowercase alphanumeric + hyphens)", name: "bucket", type: String },
        { description: "email: verified destination address to use without prompting", name: "mail-to", type: String },
        { description: "Skip prompts (auth provider, DB name, bucket name, mail destination) and use the defaults", name: "yes", type: Boolean },
        { description: "Local registry root (offline; expects <name>/ subdirs)", name: "from", type: String },
        { description: "Override the remote registry source base (e.g. gh:owner/repo/registry)", name: "source", type: String },
        {
            description: "Fetch items from a git ref (branch, tag, or commit), e.g. --ref alpha. Overrides the version-derived default",
            name: "ref",
            type: String,
        },
        { description: "Permit --source values outside gh:/github:/https://", name: "allow-unsafe-source", type: Boolean },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
    ],
};

export { addCommand };

export type AddOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    bucket: string | undefined;
    db: string | undefined;
    format: string | undefined;
    from: string | undefined;
    "mail-to": string | undefined;
    provider: string | undefined;
    ref: string | undefined;
    source: string | undefined;
    yes: boolean | undefined;
}>;
