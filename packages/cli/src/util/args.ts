/**
 * Tiny argv parser. Supports:
 *   - `--name value`, `--name=value`, `--flag`
 *   - `-x value`, `-xvalue`
 *   - positional arguments (everything else, in order)
 *   - `--` terminator (everything after is positional)
 *
 * Intentionally small — replaces a full CLI library for the handful of
 * subcommands we need.
 */
export interface ParsedArgs {
    flags: Record<string, boolean>;
    options: Record<string, string>;
    positional: ReadonlyArray<string>;
}

export const parseArgs = (argv: ReadonlyArray<string>, booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs => {
    const flags: Record<string, boolean> = {};
    const options: Record<string, string> = {};
    const positional: string[] = [];

    let index = 0;
    let terminated = false;

    while (index < argv.length) {
        const token = argv[index];

        if (token === undefined) {
            index += 1;

            continue;
        }

        if (terminated) {
            positional.push(token);
            index += 1;

            continue;
        }

        if (token === "--") {
            terminated = true;
            index += 1;

            continue;
        }

        if (token.startsWith("--")) {
            const body = token.slice(2);
            const eqIndex = body.indexOf("=");

            if (eqIndex !== -1) {
                const name = body.slice(0, eqIndex);
                const value = body.slice(eqIndex + 1);

                options[name] = value;
                index += 1;

                continue;
            }

            if (booleanFlags.has(body)) {
                flags[body] = true;
                index += 1;

                continue;
            }

            const next = argv[index + 1];

            if (next !== undefined && !next.startsWith("-")) {
                options[body] = next;
                index += 2;

                continue;
            }

            flags[body] = true;
            index += 1;

            continue;
        }

        if (token.startsWith("-") && token.length > 1) {
            const body = token.slice(1);

            if (body.length > 1) {
                options[body[0] as string] = body.slice(1);
                index += 1;

                continue;
            }

            const next = argv[index + 1];

            if (next !== undefined && !next.startsWith("-")) {
                options[body] = next;
                index += 2;

                continue;
            }

            flags[body] = true;
            index += 1;

            continue;
        }

        positional.push(token);
        index += 1;
    }

    return { flags, options, positional };
};
