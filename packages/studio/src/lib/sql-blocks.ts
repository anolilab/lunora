/**
 * Read the fenced SQL out of an assistant reply.
 *
 * In `lib/` rather than beside the panel because it is a pure parser with
 * non-obvious behaviour, and it is the one path from a model reply into the SQL
 * editor — the piece most worth testing on its own.
 */
/** Opening fence of the only block shape offered for insertion. */
const SQL_FENCE = "```sql";

/** Closing fence. */
const FENCE = "```";

/**
 * Pull the fenced SQL out of a reply.
 *
 * A scan rather than a regex: the obvious pattern (`/```sql\s*([\S\s]*?)```/`)
 * is polynomial-backtracking on a model reply, which is exactly the input not to
 * hand an ambiguous matcher.
 *
 * Deliberately narrow in what it accepts, too. Only a fenced ```sql block counts;
 * a looser reading — "any line starting with SELECT" — would offer prose as a
 * statement, and this button is the one path from a model reply into the editor.
 * An unterminated block yields nothing, because half a statement is not one.
 */
const sqlBlocks = (reply: string): string[] => {
    const blocks: string[] = [];

    for (const part of reply.split(SQL_FENCE).slice(1)) {
        const end = part.indexOf(FENCE);
        const sql = end === -1 ? "" : part.slice(0, end).trim();

        if (sql !== "") {
            blocks.push(sql);
        }
    }

    return blocks;
};

export default sqlBlocks;
