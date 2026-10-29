import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";

const LIB_ES5 = "/node_modules/typescript/lib/lib.es5.d.ts";

const checkedProject = (source: string, compilerOptions = {}): Project => {
    const project = new Project({ compilerOptions, useInMemoryFileSystem: true });

    project.createSourceFile("/fixture.ts", source);
    project.getPreEmitDiagnostics();

    return project;
};

describe("shared lib source files (vitest setup)", () => {
    it("hands every Project the same parsed lib SourceFile", () => {
        expect.assertions(2);

        const first = checkedProject("export const a = 1;");
        const second = checkedProject("export const b = 2;");
        const firstLib = first.getProgram().compilerObject.getSourceFile(LIB_ES5);

        expect(firstLib).toBeDefined();
        expect(second.getProgram().compilerObject.getSourceFile(LIB_ES5)).toBe(firstLib);
    });

    it("does not share a lib parsed under options that change how it parses", () => {
        expect.assertions(3);

        const es5 = checkedProject("export const a = 1;", { target: ts.ScriptTarget.ES5 });
        const esNext = checkedProject("export const a = 1;", { target: ts.ScriptTarget.ESNext });
        const esNextLib = esNext.getProgram().compilerObject.getSourceFile(LIB_ES5);

        // Sharing is active for these options, so the inequality below comes from the key, not from no sharing at all.
        expect(checkedProject("export const b = 2;", { target: ts.ScriptTarget.ESNext }).getProgram().compilerObject.getSourceFile(LIB_ES5)).toBe(esNextLib);
        expect(esNextLib).not.toBe(es5.getProgram().compilerObject.getSourceFile(LIB_ES5));
        expect(esNextLib?.languageVersion).toBe(ts.ScriptTarget.ESNext);
    });

    it("keeps each Project's own files and wrappers to itself", () => {
        expect.assertions(5);

        const first = checkedProject("export interface Only { first: string }");
        const second = checkedProject("export interface Only { second: number }");

        // The libs are shared, so the fixture separation below holds while sharing is on.
        expect(second.getProgram().compilerObject.getSourceFile(LIB_ES5)).toBe(first.getProgram().compilerObject.getSourceFile(LIB_ES5));

        expect(first.getSourceFileOrThrow("/fixture.ts").getInterfaceOrThrow("Only").getPropertyOrThrow("first")).toBeDefined();
        expect(second.getSourceFileOrThrow("/fixture.ts").getInterfaceOrThrow("Only").getProperty("first")).toBeUndefined();
        expect(second.getSourceFileOrThrow("/fixture.ts").getInterfaceOrThrow("Only").getPropertyOrThrow("second").getType().getText()).toBe("number");

        const arrayInSecond = second.getSourceFileOrThrow(LIB_ES5).getInterfaceOrThrow("Array");

        expect(arrayInSecond.getProject()).toBe(second);
    });
});
