import { createInterface } from "node:readline";

/**
 * Whether we can interactively prompt — stdin must be a TTY. In CI / piped
 * contexts this is false, and callers should fall back to a non-interactive
 * default (skip, or require an explicit `--yes`) rather than hang on a read.
 */
const isInteractive = (): boolean => process.stdin.isTTY;

/**
 * Ask a yes/no question on stdin. With `defaultYes`, an empty answer (just
 * Enter) counts as yes and the prompt should read `[Y/n]`; otherwise empty is
 * no (`[y/N]`). Shared by the CLI (`reset`, `dev`) and the Vite dev server.
 */
const promptYesNo = async (prompt: string, options?: { defaultYes?: boolean }): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(prompt, (input) => {
                resolve(input);
            });
        });

        const normalised = answer.trim().toLowerCase();

        if (normalised === "") {
            return options?.defaultYes === true;
        }

        return normalised === "y" || normalised === "yes";
    } finally {
        rl.close();
    }
};

/**
 * Build a default-yes `confirm(message)` for the scaffolders' `ensureDevVariables`:
 * an interactive `[Y/n]` prompt (optionally prefixed, e.g. `"[cirrus] "`) when
 * stdin is a TTY, or an immediate `false` otherwise — so CI declines silently
 * instead of blocking. Keeps the "non-interactive ⇒ decline" policy in one place
 * rather than re-stated at every call site.
 */
const createConfirm = (prefix = ""): ((message: string) => Promise<boolean>) =>
    isInteractive() ? (message: string) => promptYesNo(`${prefix}${message} [Y/n] `, { defaultYes: true }) : () => Promise.resolve(false);

export { createConfirm, isInteractive, promptYesNo };
