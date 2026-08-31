import type { ImportDeclaration, Project } from "ts-morph";

import { listLunoraSourceFiles } from "./ast";

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

/** Sandbox tool name → the {@link SandboxUsage} flag its value import sets. */
const TOOL_FLAGS: Record<string, keyof SandboxUsage> = {
    browserTool: "usesSandboxBrowser",
    containerTool: "usesSandboxContainer",
    fsTool: "usesSandboxFs",
};

/**
 * Which sandbox tools a project imports from `@lunora/agent` (main entry or the
 * `/sandbox` subpath), detected by NAMED value import. Drives two things:
 * registering the `sandbox:invoke` dispatcher (ANY of the three tools — an agent
 * whose only sandbox tool was `fsTool` used to be missed here, so every
 * `ls`/`read`/`write`/`rm`/`stat` died on FUNCTION_NOT_FOUND) and provisioning
 * the `BROWSER` wrangler binding (`browserTool` only — the browser op runs on
 * `ctx.browser` inside the dispatcher, while `fsTool` reads a hand-declared R2
 * bucket).
 */
interface SandboxUsage {
    /** `import { browserTool } from "@lunora/agent"` (or `/sandbox`) appears in `lunora/`. */
    usesSandboxBrowser: boolean;
    /** `import { containerTool } from "@lunora/agent"` (or `/sandbox`) appears in `lunora/`. */
    usesSandboxContainer: boolean;
    /** `import { fsTool } from "@lunora/agent"` (or `/sandbox`) appears in `lunora/`. */
    usesSandboxFs: boolean;
}

/** All-`false` usage — the starting point of every scan, and the answer for a project importing no sandbox tool. */
const noSandboxUsage = (): SandboxUsage => {
    return { usesSandboxBrowser: false, usesSandboxContainer: false, usesSandboxFs: false };
};

/** Which sandbox tools a single import declaration pulls in (all-`false` if not the sandbox module). */
const scanImportDeclaration = (declaration: ImportDeclaration): SandboxUsage => {
    const found = noSandboxUsage();

    if (!SANDBOX_MODULE_SPECIFIERS.has(declaration.getModuleSpecifierValue()) || declaration.isTypeOnly()) {
        return found;
    }

    for (const named of declaration.getNamedImports()) {
        if (named.isTypeOnly()) {
            continue;
        }

        const flag = TOOL_FLAGS[named.getNameNode().getText()];

        if (flag !== undefined) {
            found[flag] = true;
        }
    }

    return found;
};

/**
 * Scan the `lunora/` source set for named imports of the sandbox tools
 * ({@link TOOL_FLAGS}) from `@lunora/agent` (main entry or the `/sandbox`
 * subpath). Type-only imports (the input/option types) do not count — only a
 * value import wires a tool into an agent. A project that imports none yields
 * all-`false` and codegen emits byte-identical output.
 */
const discoverSandboxUsage = (project: Project, lunoraDirectory: string): SandboxUsage => {
    const usage = noSandboxUsage();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const declaration of sourceFile.getImportDeclarations()) {
            const found = scanImportDeclaration(declaration);

            for (const flag of Object.values(TOOL_FLAGS)) {
                usage[flag] ||= found[flag];
            }
        }

        if (Object.values(TOOL_FLAGS).every((flag) => usage[flag])) {
            break;
        }
    }

    return usage;
};

export { discoverSandboxUsage };
export type { SandboxUsage };
