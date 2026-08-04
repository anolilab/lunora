/* eslint-disable no-secrets/no-secrets -- JSDoc quotes the `<build|push|images|list|info|delete>` subcommand list, not a credential. */

import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora containers <build|push|images|list|info|delete>` — thin wrappers over
 * `wrangler containers …` so container image + instance management lives under
 * the same CLI as the rest of the deploy workflow (and CI recipes can split
 * image build/push from `lunora deploy`).
 */
const containersCommand: Command = {
    argument: { description: "<build|push|images|list|info|delete> [args…]", name: "args", type: String },
    description: "Build/push container images and manage container instances (wraps wrangler containers)",
    examples: [
        ["lunora containers build ./containers/transcoder --tag transcoder:v1", "Build a container image with the local Docker engine"],
        ["lunora containers build ./containers/transcoder --tag transcoder:v1 --push", "Build and push to the Cloudflare Registry in one step"],
        ["lunora containers push transcoder:v1", "Push a locally-tagged image to the Cloudflare Registry"],
        ["lunora containers images list", "List images in your Cloudflare Registry"],
        ["lunora containers images delete transcoder:v1", "Delete an image to free registry storage"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "containers",
    options: [
        { description: "build: push the image to the Cloudflare Registry after building", name: "push", type: Boolean },
        { description: "build: name:tag for the image (forwarded to wrangler --tag)", name: "tag", type: String },
        { description: "Cloudflare environment name", name: "env", type: String },
    ],
};

export { containersCommand };

export type ContainersOptions = CreateOptions<{
    env: string | undefined;
    push: boolean | undefined;
    tag: string | undefined;
}>;
