import { SDK_LANGUAGES } from "@lunora/codegen";
import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const sdkCommand: Command = {
    argument: { description: "<generate>", name: "args", type: String },
    description: "Generate a typed client SDK for another language from the project's OpenRPC surface",
    examples: [
        ["lunora sdk generate --lang python", "Emit a Python SDK into ./sdk/python"],
        ["lunora sdk generate --lang go --out ./clients/go", "Choose the language and output directory"],
        ["lunora sdk generate --lang kotlin", "Any of the registered targets; --lang lists them"],
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
    ],
};

export { sdkCommand };

export type SdkOptions = CreateOptions<{ lang: string | undefined; out: string | undefined; spec: string | undefined }>;
