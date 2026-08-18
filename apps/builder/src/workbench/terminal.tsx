import { useAction } from "@lunora/react";
import type { ChangeEventHandler, FormEventHandler, JSX } from "react";
import { useCallback, useState } from "react";

import { api } from "#lunora/_generated/api.js";

interface TerminalLine {
    code: number;
    command: string;
    driver: string;
    /** Monotonic per-session id, so an append-only log has a stable React key. */
    id: number;
    output: string;
}

/** Runs of whitespace between a command and its arguments. Hoisted so it is compiled once. */
const WHITESPACE = /\s+/u;

/**
 * The command pane.
 *
 * It shows the driver that answered on every line — `simulated` until a
 * container binding exists. That label is not decoration: a user who is told a
 * command ran must be able to tell whether it ran anywhere real, and a builder
 * that quietly reports simulated success is worse than one with no terminal.
 */
const Terminal = ({ projectId }: { projectId: string }): JSX.Element => {
    // `useAction` is the adapter's action primitive — the follow-up this pane
    // used to name in a comment while calling `client.action` through
    // `useLunora()` by hand. Its `pending` is ref-counted across overlapping
    // invocations, which is why there is no local `busy` flag any more.
    const { call: runCommand, pending } = useAction(api.commands.run);

    const [input, setInput] = useState("");
    const [lines, setLines] = useState<ReadonlyArray<TerminalLine>>([]);

    const onChange: ChangeEventHandler<HTMLInputElement> = useCallback((event) => {
        setInput(event.target.value);
    }, []);

    const onSubmit: FormEventHandler<HTMLFormElement> = useCallback(
        (event) => {
            event.preventDefault();

            const parts = input.trim().split(WHITESPACE).filter(Boolean);

            if (parts.length === 0) {
                return;
            }

            const [command, ...args] = parts;

            setInput("");

            // An inner async function rather than a `.then().catch()` chain:
            // the failure path is not an error here, it is a line in the log —
            // a refused command's message names what IS allowed, which is the
            // most useful thing the pane can show.
            const dispatch = async (): Promise<void> => {
                try {
                    const result = await runCommand({ args, command, projectId });

                    setLines((previous) => [
                        ...previous,
                        { code: result.code, command: parts.join(" "), driver: result.driver, id: previous.length, output: result.stdout || result.stderr },
                    ]);
                } catch (error: unknown) {
                    setLines((previous) => [
                        ...previous,
                        {
                            code: -1,
                            command: parts.join(" "),
                            driver: "refused",
                            id: previous.length,
                            output: error instanceof Error ? error.message : String(error),
                        },
                    ]);
                }
            };

            void dispatch();
        },
        [input, projectId, runCommand],
    );

    return (
        <div className="terminal">
            <ol className="terminal-log">
                {lines.map((line) => (
                    <li key={line.id}>
                        <div className="terminal-command">
                            <span className="prompt">$</span> {line.command}
                            <span className={line.driver === "container" ? "badge badge-real" : "badge"}>{line.driver}</span>
                        </div>
                        <pre className={line.code === 0 ? "terminal-output" : "terminal-output terminal-output-failed"}>{line.output}</pre>
                    </li>
                ))}
            </ol>

            <form className="terminal-input" onSubmit={onSubmit}>
                <span className="prompt">$</span>
                <input aria-label="Run a command" disabled={pending} onChange={onChange} placeholder="lunora verify" value={input} />
            </form>
        </div>
    );
};

export { Terminal };
