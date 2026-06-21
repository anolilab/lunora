import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora add &lt;feature>` — add a feature or registry item to an existing
 * project. A thin, discoverable front door over `lunora registry add`: the
 * friendly aliases (`auth` asks which provider, `email`/`mail` → the mail item)
 * resolve to registry item(s); any other name is passed straight to the
 * registry (e.g. `storage`, `crons`, `presence`, `ratelimit`, `backup`,
 * `auth-clerk`). One install path behind every front door.
 */
const addCommand: Command = {
    argument: { description: "Feature or registry item: auth | email | storage | crons | presence | ratelimit | backup | …", name: "feature", type: String },
    description: "Add a feature or registry item (auth, email, storage, crons, …) to the current Lunora project",
    examples: [
        ["lunora add auth", "Add authentication (asks which provider)"],
        ["lunora add auth --provider clerk", "Add Clerk auth without prompting"],
        ["lunora add email", "Add transactional email (Cloudflare Email Workers + dev mail catcher)"],
        ["lunora add storage", "Add the R2 storage registry item"],
        ["lunora add crons", "Add the scheduled-jobs registry item"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "add",
    options: [
        { description: "auth: provider to use without prompting (auth | clerk | auth0)", name: "provider", type: String },
        { description: "Skip the provider prompt and use the default (email & password)", name: "yes", type: Boolean },
        { description: "Local registry root (offline; expects <name>/ subdirs)", name: "from", type: String },
        { description: "Override the remote registry source base (e.g. gh:owner/repo/registry)", name: "source", type: String },
        { description: "Permit --source values outside gh:/github:/https://", name: "allow-unsafe-source", type: Boolean },
    ],
};

export { addCommand };

export type AddOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    from: string | undefined;
    provider: string | undefined;
    source: string | undefined;
    yes: boolean | undefined;
}>;
