import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora link` — record the deployed Worker's name + public URL in
 * `.lunora/project.json` so URL-targeting commands (`logs`, `run`,
 * `deploy --migrate`, the deploy summary) stop needing `--url` every time.
 */
const linkCommand: Command = {
    description: "Link this checkout to its deployed Worker (writes .lunora/project.json)",
    examples: [
        ["lunora link --url https://app.acme.workers.dev", "Link to a deployed Worker URL"],
        ["lunora link --url https://app.acme.workers.dev --env production", "Link a named environment"],
        ["lunora link --remove", "Remove the link"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "link",
    options: [
        { description: "Cloudflare environment name to record alongside the link", name: "env", type: String },
        { description: "Worker name (defaults to the `name` in wrangler config)", name: "name", type: String },
        { description: "Remove the existing link (.lunora/project.json)", name: "remove", type: Boolean },
        { description: "Deployed Worker URL to link (e.g. https://app.acme.workers.dev)", name: "url", type: String },
    ],
};

export { linkCommand };

export type LinkOptions = CreateOptions<{
    env: string | undefined;
    name: string | undefined;
    remove: boolean | undefined;
    url: string | undefined;
}>;
