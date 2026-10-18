import type { ImportDeclaration, Project } from "ts-morph";

import { listLunoraSourceFiles } from "./ast";

/** The package the agent tools are imported from. */
const AGENT_MODULE_SPECIFIER = "@lunora/agent";

/**
 * The agent tool that asks a human for a secret value. Reserved: its import from
 * {@link AGENT_MODULE_SPECIFIER} is the signal, and the tool itself is not shipped
 * yet. Mirrors how `jsCodeTool` drives `workerLoaders` (see `./sandbox`), except
 * this tool is not a sandbox tool and so gets its own scan rather than a flag in
 * `SandboxUsage`.
 */
const REQUEST_SECRET_TOOL = "requestSecretTool";

/** Whether an import declaration value-imports {@link REQUEST_SECRET_TOOL} from the agent package. */
const importsRequestSecretTool = (declaration: ImportDeclaration): boolean => {
    if (declaration.getModuleSpecifierValue() !== AGENT_MODULE_SPECIFIER || declaration.isTypeOnly()) {
        return false;
    }

    return declaration.getNamedImports().some((named) => !named.isTypeOnly() && named.getNameNode().getText() === REQUEST_SECRET_TOOL);
};

/**
 * Whether any source in `lunora/` value-imports `requestSecretTool` from
 * `@lunora/agent`. A type-only import does not count: only a value import wires
 * the tool into an agent. A project without it yields `false` and codegen emits
 * byte-identical output.
 */
const discoverSecretValueToolUsage = (project: Project, lunoraDirectory: string): boolean => {
    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (sourceFile.getImportDeclarations().some((declaration) => importsRequestSecretTool(declaration))) {
            return true;
        }
    }

    return false;
};

export default discoverSecretValueToolUsage;
