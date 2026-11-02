/**
 * Read the fenced SQL out of an assistant reply.
 *
 * In `lib/` rather than beside the panel because it is a pure parser with
 * non-obvious behaviour, and it is the one path from a model reply into the SQL
 * editor — the piece most worth testing on its own.
 */
/** Fence marker. A block opens and closes with three backticks at the start of a line. */
const FENCE = "```";

/**
 * What an opening fence starts: a `sql` block, a fence this function has no claim
 * on, or nothing at all. The language tag must be exactly `sql`.
 */
const openingFence = (trimmed: string): "foreign" | "sql" | undefined => {
    if (!trimmed.startsWith(FENCE)) {
        return undefined;
    }

    return trimmed.slice(FENCE.length).trim().toLowerCase() === "sql" ? "sql" : "foreign";
};

/**
 * Read the fenced SQL out of an assistant reply.
 *
 * Parses FENCE LINES rather than splitting on a substring. Splitting accepted
 * any language tag starting with `sql` — ```sqlite and ```sqlx both matched and
 * their contents were offered for insertion — and matched the marker wherever it
 * appeared, including inside prose or inside another fenced block.
 *
 * A scan rather than a regex: the obvious pattern is polynomial-backtracking on a
 * model reply, which is exactly the input not to hand an ambiguous matcher.
 *
 * Deliberately narrow in what it accepts. A looser reading — "any line starting
 * with SELECT" — would offer prose as a statement, and this is the one path from
 * a model reply into the SQL editor. An unterminated block yields nothing,
 * because half a statement is not one.
 */

const sqlBlocks = (reply: string): string[] => {
    const blocks: string[] = [];
    const lines = reply.split("\n");

    let open: string[] | undefined;
    // A fence this function has no claim on. Its lines are its own text, so a ```sql
    // line inside it is not a block; the flag holds until the bare closing fence.
    let foreign = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (foreign) {
            foreign = trimmed !== FENCE;

            continue;
        }

        if (open === undefined) {
            const kind = openingFence(trimmed);

            if (kind === "sql") {
                open = [];
            } else if (kind === "foreign") {
                foreign = true;
            }

            continue;
        }

        if (trimmed === FENCE) {
            const sql = open.join("\n").trim();

            if (sql !== "") {
                blocks.push(sql);
            }

            open = undefined;

            continue;
        }

        open.push(line);
    }

    // `open !== undefined` here means the reply ended mid-block; it yields nothing.
    return blocks;
};

export default sqlBlocks;
