import type { ImportDeclaration, Project } from "ts-morph";

import { listLunoraSourceFiles } from "./discover-functions";

/**
 * The specifiers the batteries-included sandbox tools are imported from. The
 * `@lunora/agent` main entry re-exports `browserTool`/`containerTool` (so the
 * documented `import { browserTool } from "@lunora/agent"` type-checks and runs),
 * and the `@lunora/agent/sandbox` subpath exports them directly. Both must be
 * detected, or a documented-but-undetected import would silently skip registering
 * the `sandbox:invoke` dispatcher and provisioning `BROWSER`, crashing only at
 * run time.
 */
const SANDBOX_MODULE_SPECIFIERS = new Set(["@lunora/agent", "@lunora/agent/sandbox"]);

/**
 * Which sandbox tools a project imports from `@lunora/agent` (main entry or the
 * `/sandbox` subpath), detected by NAMED value import. Drives two things:
 * registering the `sandbox:invoke` dispatcher (either tool) and provisioning the
 * `BROWSER` wrangler binding (`browserTool` — the browser op runs on
 * `ctx.browser` inside the dispatcher).
 */
interface SandboxUsage {
    /** `import { browserTool } from "@lunora/agent"` (or `/sandbox`) appears in `lunora/`. */
    usesSandboxBrowser: boolean;
    /** `import { containerTool } from "@lunora/agent"` (or `/sandbox`) appears in `lunora/`. */
    usesSandboxContainer: boolean;
}

/**
 * Scan the `lunora/` source set for named imports of `browserTool`/`containerTool`
 * from `@lunora/agent` (main entry or the `/sandbox` subpath). Type-only imports
 * (the input/option types) do not count — only a value import wires a tool into an
 * agent. This is additive and back-compat: a project that imports neither yields
 * all-`false` and codegen emits byte-identical output.
 */
/** Which sandbox tools a single import declaration pulls in (all-`false` if not the sandbox module). */
const scanImportDeclaration = (declaration: ImportDeclaration): SandboxUsage => {
    const found: SandboxUsage = { usesSandboxBrowser: false, usesSandboxContainer: false };

    if (!SANDBOX_MODULE_SPECIFIERS.has(declaration.getModuleSpecifierValue()) || declaration.isTypeOnly()) {
        return found;
    }

    for (const named of declaration.getNamedImports()) {
        if (named.isTypeOnly()) {
            continue;
        }

        const name = named.getNameNode().getText();

        if (name === "browserTool") {
            found.usesSandboxBrowser = true;
        } else if (name === "containerTool") {
            found.usesSandboxContainer = true;
        }
    }

    return found;
};

const discoverSandboxUsage = (project: Project, lunoraDirectory: string): SandboxUsage => {
    const usage: SandboxUsage = { usesSandboxBrowser: false, usesSandboxContainer: false };

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const declaration of sourceFile.getImportDeclarations()) {
            const found = scanImportDeclaration(declaration);

            usage.usesSandboxBrowser ||= found.usesSandboxBrowser;
            usage.usesSandboxContainer ||= found.usesSandboxContainer;
        }

        if (usage.usesSandboxBrowser && usage.usesSandboxContainer) {
            break;
        }
    }

    return usage;
};

export { discoverSandboxUsage };
export type { SandboxUsage };
