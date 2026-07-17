import { createInterface } from "node:readline";

/** Splits a multi-select answer into tokens on commas and/or whitespace. Hoisted so it isn't re-compiled per call. */
const MULTI_SELECT_SEPARATOR = /[\s,]+/u;

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
 * an interactive `[Y/n]` prompt (optionally prefixed, e.g. `"[lunora] "`) when
 * stdin is a TTY, or an immediate `false` otherwise — so CI declines silently
 * instead of blocking. Keeps the "non-interactive ⇒ decline" policy in one place
 * rather than re-stated at every call site.
 */
const createConfirm = (prefix = ""): ((message: string) => Promise<boolean>) =>
    isInteractive() ? (message: string) => promptYesNo(`${prefix}${message} [Y/n] `, { defaultYes: true }) : () => Promise.resolve(false);

/** One choice in a {@link promptSelect} list. `value` is returned; `label` (and optional `description`) are shown. */
interface SelectOption<T extends string> {
    description?: string;
    label: string;
    value: T;
}

/**
 * Ask the user to pick one option from a numbered list on stdin. Accepts the
 * 1-based number or the option's `value`/`label` typed verbatim; an empty answer
 * (just Enter) takes `settings.default`. In a non-interactive context (CI /
 * piped — no TTY) it never reads and returns `settings.default` (or `undefined`),
 * mirroring {@link createConfirm}'s "non-interactive ⇒ fall back" policy so
 * automation never blocks.
 */
const promptSelect = async <T extends string>(message: string, options: ReadonlyArray<SelectOption<T>>, settings?: { default?: T }): Promise<T | undefined> => {
    if (!isInteractive() || options.length === 0) {
        return settings?.default;
    }

    const defaultIndex = settings?.default === undefined ? -1 : options.findIndex((option) => option.value === settings.default);
    const lines = options.map(
        (option, index) => `  ${String(index + 1)}) ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`,
    );
    const promptMessage = `${message}\n${lines.join("\n")}\n> ${defaultIndex >= 0 ? `[${String(defaultIndex + 1)}] ` : ""}`;

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(promptMessage, (input) => {
                resolve(input);
            });
        });

        const trimmed = answer.trim();

        if (trimmed === "") {
            return settings?.default;
        }

        const choice = Number.parseInt(trimmed, 10);

        if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
            return options[choice - 1]?.value;
        }

        // Also accept the option's value or label typed verbatim.
        const byText = options.find((option) => option.value === trimmed || option.label.toLowerCase() === trimmed.toLowerCase());

        return byText?.value ?? settings?.default;
    } finally {
        rl.close();
    }
};

/**
 * Ask a free-text question on stdin, returning the trimmed answer. An empty
 * answer (just Enter) takes `settings.default`. In a non-interactive context
 * (CI / piped — no TTY) it never reads and returns `settings.default` (or
 * `undefined`), mirroring {@link promptSelect}'s "non-interactive ⇒ fall back"
 * policy so automation never blocks.
 */
const promptText = async (message: string, settings?: { default?: string }): Promise<string | undefined> => {
    if (!isInteractive()) {
        return settings?.default;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(message, (input) => {
                resolve(input);
            });
        });

        const trimmed = answer.trim();

        return trimmed === "" ? settings?.default : trimmed;
    } finally {
        rl.close();
    }
};

/** One choice in a {@link promptMultiSelect} list. Identical shape to {@link SelectOption}; `value` is returned when picked. */
type MultiSelectOption<T extends string> = SelectOption<T>;

/**
 * Ask the user to pick zero or more options from a numbered list on stdin.
 * Accepts a comma- or space-separated list of 1-based numbers and/or option
 * `value`/`label`s typed verbatim; an empty answer (just Enter) takes
 * `settings.defaults`. In a non-interactive context (CI / piped — no TTY) it
 * never reads and returns `settings.defaults ?? []`, mirroring {@link promptSelect}'s
 * "non-interactive ⇒ fall back" policy so automation never blocks. Unknown
 * tokens are ignored; the returned list is de-duplicated and preserves option
 * order.
 */
const promptMultiSelect = async <T extends string>(
    message: string,
    options: ReadonlyArray<MultiSelectOption<T>>,
    settings?: { defaults?: ReadonlyArray<T> },
): Promise<T[]> => {
    const defaults = settings?.defaults ?? [];

    if (!isInteractive() || options.length === 0) {
        return [...defaults];
    }

    const lines = options.map(
        (option, index) => `  ${String(index + 1)}) ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`,
    );
    const defaultHint = defaults.length === 0 ? "" : `[${defaults.join(", ")}] `;
    const promptMessage = `${message} (comma-separated; Enter for default)\n${lines.join("\n")}\n> ${defaultHint}`;

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(promptMessage, (input) => {
                resolve(input);
            });
        });

        const trimmed = answer.trim();

        if (trimmed === "") {
            return [...defaults];
        }

        // Tokens split on commas or whitespace; each is a 1-based index or a
        // value/label typed verbatim. Resolve to values, preserving option order.
        const tokens = trimmed
            .split(MULTI_SELECT_SEPARATOR)
            .map((token) => token.trim())
            .filter((token) => token !== "");
        const picked = new Set<T>();

        for (const token of tokens) {
            const choice = Number.parseInt(token, 10);

            if (Number.isInteger(choice) && choice >= 1 && choice <= options.length && String(choice) === token) {
                const byIndex = options[choice - 1]?.value;

                if (byIndex !== undefined) {
                    picked.add(byIndex);
                }

                continue;
            }

            const byText = options.find((option) => option.value === token || option.label.toLowerCase() === token.toLowerCase());

            if (byText !== undefined) {
                picked.add(byText.value);
            }
        }

        return options.filter((option) => picked.has(option.value)).map((option) => option.value);
    } finally {
        rl.close();
    }
};

export { createConfirm, isInteractive, promptMultiSelect, promptSelect, promptText, promptYesNo };
export type { MultiSelectOption, SelectOption };
