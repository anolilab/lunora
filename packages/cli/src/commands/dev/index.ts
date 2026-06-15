import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";

const devCommand: Command = {
    description: "Run the dev stack: wrangler worker + studio + codegen watch",
    examples: [
        ["lunora dev", "Run the worker + studio + codegen watch"],
        ["lunora dev --no-studio", "Skip the embedded studio server"],
        ["lunora dev --worker-port 8080", "Use a custom wrangler dev port"],
        ["lunora dev --remote", "Proxy D1/KV/R2 to the deployed worker (also LUNORA_REMOTE=1)"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "dev",
    options: [
        { description: `Which API spec(s) codegen emits: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Studio server port (default 6173)", name: "port", type: Number },
        { description: "wrangler dev port (default 8787)", name: "worker-port", type: Number },
        { description: "Don't start the embedded studio server", name: "no-studio", type: Boolean },
        { description: "Don't watch + regenerate codegen", name: "no-codegen", type: Boolean },
        { description: "Proxy D1/KV/R2 bindings to the deployed worker (or set LUNORA_REMOTE=1)", name: "remote", type: Boolean },
    ],
};

export { devCommand };

export type DevOptions = CreateOptions<{
    "api-spec": string | undefined;
    // The `--no-codegen` / `--no-studio` flags are declared as `no-*` options but
    // cerebro exposes them under the negated positive key at runtime.
    codegen: boolean | undefined;
    port: number | undefined;
    remote: boolean | undefined;
    studio: boolean | undefined;
    "worker-port": number | undefined;
}>;
