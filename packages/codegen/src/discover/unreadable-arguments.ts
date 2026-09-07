import type { Finding } from "@lunora/advisor";
import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import { procedureArgumentObjects } from "../procedure-argument-objects";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/**
 * Report a registered procedure whose declared arguments could not be fully
 * read, so the generated type under-states what the runtime enforces.
 *
 * Codegen resolves an `.input(sharedArgs)` and a `{ ...sharedArgs }` to the
 * `const` object literal behind them. What it cannot resolve is a record
 * ASSEMBLED at runtime — `defineListArgs(...).args`, which `lunora introspect`
 * generates, or a factory call — and that is the case this reports.
 *
 * A warning, never an abort. The unreadable forms are shipped, documented APIs
 * with no inline equivalent to fall back to, so refusing them would leave those
 * projects unable to generate at all; and the runtime validator still enforces
 * every field, so the code WORKS — it is the generated type that is thin.
 *
 * Silence was the expensive part. A caller passing a real argument was told the
 * property does not exist, usually in another package entirely, which reads as a
 * typo rather than as "your argument list was dropped".
 */
const findingFor = (relativePath: string, exportName: string, line: number): Finding => {
    return {
        cacheKey: `procedure_arguments_unreadable:${relativePath}:${exportName}`,
        categories: ["SCHEMA"],
        description:
            "Codegen reads an argument record statically. One built at runtime — a factory call, or a property off a value it cannot follow — has no literal to read, so the generated `FunctionReference` carries only the arguments it could see while the runtime validator still enforces all of them.",
        detail: `\`${exportName}\` in \`${relativePath}\` (line ${line.toString()}) declares arguments codegen could not read, so its generated type is missing some of them.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName, filePath: relativePath, line },
        name: "procedure_arguments_unreadable",
        remediation: `Declare the arguments as an object literal, or as a \`const\` object literal the chain names — \`const ${exportName}Args = { … };\` then \`.input(${exportName}Args)\`. Both resolve; a record returned by a call does not.`,
        title: "Procedure arguments are missing from the generated type",
    };
};

/**
 * Whether this registration DECLARES an argument record that could not be read.
 *
 * Narrower than `opaque`, deliberately. `opaque` is the conservative tri-state a
 * security lint gates on, so it also covers "the whole registration is a
 * variable, and args may or may not exist" — reporting that as a dropped
 * argument list would be a guess. A bare-factory call only counts when an `args`
 * property is actually there and unreadable; a builder chain only ever reports
 * opaque for an `.input()` step it could not read, so it needs no extra gate.
 */
const declaresUnreadableArguments = (call: CallExpression, receiver: TsNode | undefined): boolean => {
    if (receiver === undefined) {
        const first = call.getArguments()[0];

        if (first === undefined || !Node.isObjectLiteralExpression(first) || first.getProperty("args") === undefined) {
            return false;
        }
    }

    return procedureArgumentObjects(call, receiver).opaque;
};

/** The `[exportName, line]` of every procedure in one file whose declared args could not be read. */
const fileFindings = (source: SourceFile, relativePath: string): Finding[] => {
    const findings: Finding[] = [];

    const check = (declaration: VariableDeclaration, exportName: string): void => {
        const initializer = declaration.getInitializer();

        if (initializer === undefined || !Node.isCallExpression(initializer)) {
            return;
        }

        const classified = classifyProcedureCall(initializer);

        if (classified !== undefined && declaresUnreadableArguments(initializer, classified.receiver)) {
            findings.push(findingFor(relativePath, exportName, initializer.getStartLineNumber()));
        }
    };

    for (const statement of source.getVariableStatements().filter((entry) => entry.isExported())) {
        for (const declaration of statement.getDeclarations()) {
            check(declaration, declaration.getName());
        }
    }

    return findings;
};

/**
 * Every procedure in the `lunora/` source set whose argument declarations codegen
 * could not fully read.
 */
const discoverUnreadableArguments = (project: Project, lunoraDirectory: string): Finding[] => {
    const findings: Finding[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        // Only files the discovery pass already loaded — never add one here, so
        // this stays a read over work that has been done.
        const source: SourceFile | undefined = project.getSourceFile(filePath);

        if (source !== undefined) {
            findings.push(...fileFindings(source, lunoraRelativePath(lunoraDirectory, filePath)));
        }
    }

    return findings.toSorted((a, b) => a.cacheKey.localeCompare(b.cacheKey));
};

export default discoverUnreadableArguments;
