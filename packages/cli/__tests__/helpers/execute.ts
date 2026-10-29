import type { CommandExecute, Toolbox } from "@visulima/cerebro";
import { vi } from "vitest";

/** What one `execute` run produced: its exit code and whatever reached stdout. */
interface ExecuteOutcome<TData> {
    code: number | undefined;
    /** The parsed `--format json` envelope; `undefined` when stdout stayed empty. */
    document: { code: number; data?: TData; error?: string } | undefined;
    stdout: string;
}

/**
 * Drive a command's cerebro `execute` with a stub toolbox, capturing stdout.
 *
 * The `--format json` envelope is written by `defineHandler`, not by the
 * `run*Command` functions — so this is the only path that exercises the document
 * contract, and asserting on it here is what keeps "stdout carries exactly one
 * JSON document" honest.
 */
const runExecute = async <TOptions extends Record<string, unknown>, TData = unknown>(
    execute: CommandExecute<Toolbox<Console, TOptions>>,
    input: { argument?: string[]; commandName: string; cwd: string; options: Partial<TOptions> },
): Promise<ExecuteOutcome<TData>> => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));

        return true;
    });

    let code: number | undefined;

    try {
        await execute({
            argument: input.argument ?? [],
            commandName: input.commandName,
            options: input.options,
            process: {
                cwd: input.cwd,
                exit: (exitCode: number): void => {
                    code = exitCode;
                },
            },
        } as unknown as Toolbox<Console, TOptions>);
    } finally {
        spy.mockRestore();
    }

    const stdout = chunks.join("");

    return { code, document: stdout === "" ? undefined : (JSON.parse(stdout) as ExecuteOutcome<TData>["document"]), stdout };
};

export type { ExecuteOutcome };
export { runExecute };
