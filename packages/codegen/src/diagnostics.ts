import type { Node } from "ts-morph";

/**
 * An error thrown by codegen discovery when the user's schema or function
 * source has a structural problem that can be pinpointed to a specific source
 * location. The `file`, `line`, and `column` properties mirror what Vite's
 * error-overlay `loc` field expects so the browser can display the exact spot.
 */
export class CodegenDiagnosticError extends Error {
    readonly file: string;
    readonly line: number;
    readonly column: number;

    constructor(message: string, file: string, line: number, column: number) {
        super(message);
        this.name = "CodegenDiagnosticError";
        this.file = file;
        this.line = line;
        this.column = column;
    }
}

/**
 * Build a {@link CodegenDiagnosticError} whose message includes the source
 * location and whose `file`/`line`/`column` properties are set from the
 * ts-morph `Node`'s position in its source file.
 *
 * Message format: `@cirrus/codegen: <detail> (<file>:<line>:<column>)`
 */
export const diagnosticAt = (node: Node, detail: string): CodegenDiagnosticError => {
    const sourceFile = node.getSourceFile();
    const file = sourceFile.getFilePath();
    const line = node.getStartLineNumber();
    const { column } = sourceFile.getLineAndColumnAtPos(node.getStart());
    const message = `@cirrus/codegen: ${detail} (${file}:${line}:${column})`;

    return new CodegenDiagnosticError(message, file, line, column);
};
