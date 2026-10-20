import type { Project } from "ts-morph";

import { listLunoraSourceFiles } from "./ast";
import { fileWiresRequestSecretTool } from "./feature-usage";

/**
 * Whether any source in `lunora/` value-imports `requestSecretTool` from
 * `@lunora/agent`, directly or through a namespace import or a relative barrel that
 * re-exports it (see {@link fileWiresRequestSecretTool}). A type-only import does not
 * count: only a value import wires the tool into an agent. A project without it yields
 * `false` and codegen emits byte-identical output.
 */
const discoverSecretValueToolUsage = (project: Project, lunoraDirectory: string): boolean => {
    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        if (fileWiresRequestSecretTool(sourceFile)) {
            return true;
        }
    }

    return false;
};

export default discoverSecretValueToolUsage;
