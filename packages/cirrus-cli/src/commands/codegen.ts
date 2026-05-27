import { runCodegen } from "@cirrus/codegen";

import type { Logger } from "../util/logger.js";

export interface CodegenCommandOptions {
    cwd?: string;
    logger: Logger;
}

export const runCodegenCommand = (options: CodegenCommandOptions): { outputDirectory: string } => {
    const projectRoot = options.cwd ?? process.cwd();

    const result = runCodegen({ projectRoot });

    options.logger.success(`codegen wrote dataModel.ts, api.ts, server.ts to ${result.outputDirectory}`);

    return { outputDirectory: result.outputDirectory };
};
