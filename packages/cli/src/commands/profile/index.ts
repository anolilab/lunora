import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { TARGET_OPTION } from "../../util/deploy-target";

/**
 * `lunora profile` — capture an on-demand CPU or heap profile from a Node-target
 * app. The app mounts `createNodeProfileHandler` on a route of its choosing, and
 * this command calls that route with the admin bearer. On the Cloudflare target
 * the command refuses and points at `lunora cloudflare profile`. Metadata only;
 * the handler (lazy-loaded via `loader`) holds the logic.
 */
const profileCommand: Command = {
    description: "Capture an on-demand CPU or heap profile (pprof) from a running Node-target app",
    examples: [
        ["lunora profile --target node --url https://app.example.com/__profile", "Capture a 10 s CPU profile of the app"],
        ["lunora profile --target node --url http://localhost:3000/__profile --type heap --duration-ms 30000", "Capture a 30 s heap profile of a local app"],
        ["lunora profile --target node --url https://app.example.com/__profile --out cpu.pprof.gz", "Write the profile to a named file"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "profile",
    options: [
        { description: "Capture window in ms, 1000–50000 (default 10000)", name: "duration-ms", type: String },
        { description: "cpu (default) or heap", name: "type", type: String },
        { description: "File to write the gzip pprof to (default profile-<type>-<time>.pprof.gz)", name: "out", type: String },
        { description: "Full URL of the profile route the app mounts createNodeProfileHandler on", name: "url", type: String },
        { description: "Admin bearer token (or LUNORA_ADMIN_TOKEN)", name: "token", type: String },
        TARGET_OPTION,
    ],
};

export { profileCommand };

export type ProfileOptions = CreateOptions<{
    "duration-ms": string | undefined;
    out: string | undefined;
    target: string | undefined;
    token: string | undefined;
    type: string | undefined;
    url: string | undefined;
}>;
