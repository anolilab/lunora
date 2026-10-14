import { SDK_LANGUAGES } from "@lunora/codegen";
import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const sdkCommand: Command = {
    argument: { description: "<generate>", name: "args", type: String },
    description: "Generate a self-contained typed client SDK for another language from the project's OpenRPC surface",
    examples: [
        ["lunora sdk generate --lang python", "Emit a Python SDK, transport included, into ./sdk/python"],
        ["lunora sdk generate --lang go --out ./clients/go", "Choose the language and output directory"],
        ["lunora sdk generate --lang dart", "A Flutter-ready Dart client — live queries arrive as a Stream"],
        ["lunora sdk generate --lang kotlin", "Any of the registered targets; --lang lists them"],
        ["lunora sdk generate --lang rust --from ./sdks", "Copy the transport from a local checkout instead of fetching it"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "sdk",
    options: [
        // The accepted values come from the target registry rather than a
        // second list here — a new target must not need this file edited too.
        { description: `Target language: ${SDK_LANGUAGES.join(" | ")}`, name: "lang", type: String },
        { description: "Output directory (default ./sdk/<lang>)", name: "out", type: String },
        {
            description: "Path to the OpenRPC document (default ./lunora/_generated/openrpc.json)",
            name: "spec",
            type: String,
        },
        // The transport-copy options. Named after the registry's, because they
        // are the registry's — see `commands/sdk/vendor.ts`.
        {
            description: "Copy the transport from a local directory of per-language transports (the repo's `sdks/`) instead of fetching it",
            name: "from",
            type: String,
        },
        {
            description: "Git ref to fetch the transport from (default: this CLI's own release tag, so the transport matches the generated surface)",
            name: "ref",
            type: String,
        },
        { description: "Override the remote transport source base (default gh:anolilab/lunora/sdks)", name: "source", type: String },
        // Offered because the shared gate's error names it. A refusal that
        // suggests a flag the command does not have sends the reader looking for
        // something that is not there.
        { description: "Permit --source values outside gh:/github:/https://", name: "allow-unsafe-source", type: Boolean },
    ],
};

export { sdkCommand };

export type SdkOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    from: string | undefined;
    lang: string | undefined;
    out: string | undefined;
    ref: string | undefined;
    source: string | undefined;
    spec: string | undefined;
}>;
