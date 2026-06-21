/**
 * Tiny argv parser.
 *
 * Supports long options (`--name value`, `--name=value`, `--flag`), short
 * options (`-x value`, `-xvalue`), positional arguments (everything else, in
 * order), and a `--` terminator after which everything is positional.
 *
 * Intentionally small — replaces a full CLI library for the handful of
 * subcommands we need.
 */
interface ParsedArgs {
    flags: Record<string, boolean>;
    options: Record<string, string>;
    positional: ReadonlyArray<string>;
}

interface Accumulator {
    flags: Record<string, boolean>;
    options: Record<string, string>;
    positional: string[];
}

/** Consume a `--long` token; returns how many argv entries were used. */
const consumeLongOption = (body: string, next: string | undefined, booleanFlags: ReadonlySet<string>, accumulator: Accumulator): number => {
    const eqIndex = body.indexOf("=");

    if (eqIndex !== -1) {
        accumulator.options[body.slice(0, eqIndex)] = body.slice(eqIndex + 1);

        return 1;
    }

    if (booleanFlags.has(body)) {
        accumulator.flags[body] = true;

        return 1;
    }

    if (next !== undefined && !next.startsWith("-")) {
        accumulator.options[body] = next;

        return 2;
    }

    accumulator.flags[body] = true;

    return 1;
};

/** Consume a `-x` token; returns how many argv entries were used. */
const consumeShortOption = (body: string, next: string | undefined, accumulator: Accumulator): number => {
    if (body.length > 1) {
        accumulator.options[body[0] as string] = body.slice(1);

        return 1;
    }

    if (next !== undefined && !next.startsWith("-")) {
        accumulator.options[body] = next;

        return 2;
    }

    accumulator.flags[body] = true;

    return 1;
};

const parseArgs = (argv: ReadonlyArray<string>, booleanFlags: ReadonlySet<string> = new Set()): ParsedArgs => {
    const accumulator: Accumulator = { flags: {}, options: {}, positional: [] };

    let index = 0;
    let terminated = false;

    while (index < argv.length) {
        const token = argv[index];

        if (token === undefined) {
            index += 1;

            continue;
        }

        if (terminated || !token.startsWith("-") || token.length === 1) {
            accumulator.positional.push(token);
            index += 1;

            continue;
        }

        if (token === "--") {
            terminated = true;
            index += 1;

            continue;
        }

        const next = argv[index + 1];

        index += token.startsWith("--")
            ? consumeLongOption(token.slice(2), next, booleanFlags, accumulator)
            : consumeShortOption(token.slice(1), next, accumulator);
    }

    return { flags: accumulator.flags, options: accumulator.options, positional: accumulator.positional };
};

export default parseArgs;
