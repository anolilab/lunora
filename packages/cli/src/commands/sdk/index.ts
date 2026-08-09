import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/** Target languages `lunora sdk generate` can emit. */
const SDK_LANGUAGES = ["python"] as const;

const SDK_LANGUAGE_HELP = SDK_LANGUAGES.join(" | ");

const sdkCommand: Command = {
    argument: { description: "<generate>", name: "args", type: String },
    description: "Generate a typed client SDK for another language from the project's OpenRPC surface",
    examples: [
        ["lunora sdk generate --lang python", "Emit a Python SDK into ./sdk/python"],
        ["lunora sdk generate --lang python --out ./clients/py", "Choose the output directory"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "sdk",
    options: [
        { description: `Target language: ${SDK_LANGUAGE_HELP}`, name: "lang", type: String },
        { description: "Output directory (default ./sdk/<lang>)", name: "out", type: String },
        {
            description: "Path to the OpenRPC document (default ./lunora/_generated/openrpc.json)",
            name: "spec",
            type: String,
        },
    ],
};

export { SDK_LANGUAGE_HELP, SDK_LANGUAGES, sdkCommand };

export type SdkOptions = CreateOptions<{ lang: string | undefined; out: string | undefined; spec: string | undefined }>;
