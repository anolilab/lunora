/**
 * Read back a data table codegen emits as `const NAME = JSON.parse("…") as T;`
 * (see `src/json-data.ts`), so tests assert on the data rather than on its
 * encoding. Throws when `name` is missing or not emitted in that form.
 *
 * Not a `*.test.ts` file, so vitest does not collect it as a suite.
 */
import ts from "typescript";

const emittedJsonData = (source: string, name: string): unknown => {
    const file = ts.createSourceFile("emitted.ts", source, ts.ScriptTarget.ES2022, true);
    const declaration = file.statements
        .filter((statement) => ts.isVariableStatement(statement))
        .flatMap((statement) => statement.declarationList.declarations)
        .find((candidate) => candidate.name.getText(file) === name);
    const initializer = declaration?.initializer;

    if (initializer === undefined || !ts.isAsExpression(initializer) || !ts.isCallExpression(initializer.expression)) {
        throw new Error(`${name} is not emitted as JSON.parse(...) as T`);
    }

    const [argument] = initializer.expression.arguments;

    if (argument === undefined || !ts.isStringLiteral(argument)) {
        throw new Error(`${name}'s JSON.parse argument is not a string literal`);
    }

    return JSON.parse(argument.text) as unknown;
};

export default emittedJsonData;
