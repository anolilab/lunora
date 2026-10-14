import { LunoraError } from "@lunora/errors";
import type { Node } from "ts-morph";

/**
 * An error thrown by codegen discovery when the user's schema or function
 * source has a structural problem that can be pinpointed to a specific source
 * location. A `LunoraError` subclass (`code: "CODEGEN_DIAGNOSTIC"`); the `file`,
 * `line`, and `column` properties (also passed through as the base `loc`) mirror
 * what Vite's error-overlay `loc` field expects so the browser can display the
 * exact spot.
 */
export class CodegenDiagnosticError extends LunoraError {
    public readonly column: number;
    public readonly file: string;
    public readonly line: number;

    public constructor(message: string, file: string, line: number, column: number) {
        super("CODEGEN_DIAGNOSTIC", message, { location: { column, file, line }, name: "CodegenDiagnosticError" });
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
 * Message format: `@lunora/codegen: <detail> (<file>:<line>:<column>)`
 *
 * `meta` is merged onto the returned error for callers that also carry the
 * project-wide `LunoraError` envelope (`code`/`name`/`status`) — it never
 * touches `file`/`line`/`column`, and the error stays an instance of
 * {@link CodegenDiagnosticError} so the Vite overlay's `instanceof` location
 * lookup is unaffected.
 */
export const diagnosticAt = (node: Node, detail: string, meta?: Record<string, unknown>): CodegenDiagnosticError => {
    const sourceFile = node.getSourceFile();
    const file = sourceFile.getFilePath();
    const line = node.getStartLineNumber();
    const { column } = sourceFile.getLineAndColumnAtPos(node.getStart());
    const message = `@lunora/codegen: ${detail} (${file}:${line.toString()}:${column.toString()})`;
    const error = new CodegenDiagnosticError(message, file, line, column);

    return meta ? Object.assign(error, meta) : error;
};
