import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const devCommand: Command = {
    argument: {
        description: "Optional subcommand: stop (shut the running dev server down) | status (report it) | logs (print its captured output)",
        name: "args",
        type: String,
    },
    description: "Run the dev stack: wrangler worker + studio + codegen watch",
    examples: [
        ["lunora dev", "Run the worker + studio + codegen watch"],
        ["lunora dev --background", "Run detached: blocks until ready, prints URL + PID, then returns"],
        ["lunora dev stop", "Stop the background/tracked dev server (idempotent)"],
        ["lunora dev status", "Report the running dev server (URL, PID, uptime)"],
        ["lunora dev logs", "Print the captured dev-server log (background runs)"],
        ["lunora dev --json", "Machine-readable JSON log lines (also LUNORA_LOG_JSON=1)"],
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
    // KEEP IN SYNC with `daemonArguments` in `./lifecycle.ts`: a new flag that
    // must reach a `--background` daemon has to be forwarded there explicitly.
    options: [
        { description: `Which API spec(s) codegen emits: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        TARGET_OPTION,
        { description: "Studio server port (default 6173)", name: "port", type: Number },
        { description: "wrangler dev port (default 8787)", name: "worker-port", type: Number },
        {
            description: "Run the dev server as a managed background process (auto-enabled when an AI agent is detected; LUNORA_AGENT_MODE=0 disables)",
            name: "background",
            type: Boolean,
        },
        { description: "Emit machine-readable JSON log lines (also LUNORA_LOG_JSON=1; auto-enabled for AI agents)", name: "json", type: Boolean },
        { description: "How many trailing lines `lunora dev logs` prints (default 100, 0 = all)", name: "lines", type: Number },
        { description: "Don't start the embedded studio server", name: "no-studio", type: Boolean },
        { description: "Don't watch + regenerate codegen", name: "no-codegen", type: Boolean },
        { description: "Proxy D1/KV/R2 bindings to the deployed worker (or set LUNORA_REMOTE=1)", name: "remote", type: Boolean },
    ],
};

export { devCommand };

export type DevOptions = CreateOptions<{
    "api-spec": string | undefined;
    background: boolean | undefined;
    // The `--no-codegen` / `--no-studio` flags are declared as `no-*` options but
    // cerebro exposes them under the negated positive key at runtime.
    codegen: boolean | undefined;
    json: boolean | undefined;
    lines: number | undefined;
    port: number | undefined;
    remote: boolean | undefined;
    studio: boolean | undefined;
    target: string | undefined;
    "worker-port": number | undefined;
}>;
