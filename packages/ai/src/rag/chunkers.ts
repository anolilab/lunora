/**
 * Structure-aware chunkers for `RagConfig.chunk`.
 *
 * The built-in {@link fixedWindowChunks} splits on a character count alone, so
 * it routinely cuts mid-sentence and mid-word. A chunk that begins halfway
 * through a clause embeds to a worse vector than the same prose split on a
 * boundary the author put there, which costs recall on every query that would
 * have matched it.
 *
 * Each export here is a **factory** returning the `(text) => string[]` shape
 * `RagConfig.chunk` takes:
 *
 * ```ts
 * defineRag({ chunk: markdownChunker({ overlap: 200, size: 1000 }), index: "docs" });
 * ```
 *
 * All three are dependency-free and deterministic, and none of them can exceed
 * its budget: an atom too large to fit on its own (one enormous sentence, one
 * heading-less wall of text) is hard-split rather than emitted as a chunk the
 * store would reject.
 * @experimental
 */
import fixedWindowChunks from "./chunk";

/**
 * Options shared by the character-budgeted chunkers. `overlap` is a **floor**
 * in characters: enough trailing atoms are carried into the next window to
 * cover it, so the realised overlap lands on an atom boundary and is usually a
 * little larger.
 */
interface ChunkerOptions {
    /** Overlap floor between adjacent chunks, in characters. Default 200. Must be `< size`. */
    overlap?: number;
    /** Maximum chunk size, in characters. Default 1000. */
    size?: number;
}

/**
 * Options for {@link tokenChunker}.
 *
 * `countTokens` is **required and injected**: a real token count needs the
 * model's tokenizer, and `@lunora/ai` will not add one as a dependency or
 * pretend a characters-per-token constant is a token count — a "token-aware"
 * chunker built on an estimate is a character chunker with extra steps, and it
 * silently overshoots on code and non-Latin scripts, which is exactly where the
 * budget matters. Pass `js-tiktoken`, `gpt-tokenizer`, or your provider's
 * counter.
 */
interface TokenChunkerOptions {
    /** Token counter for the target model — e.g. `(text) => encoding.encode(text).length`. */
    countTokens: (text: string) => number;
    /** Maximum chunk size, in tokens. Default 256. */
    maxTokens?: number;
    /** Overlap floor between adjacent chunks, in tokens. Default 0. Must be `< maxTokens`. */
    overlapTokens?: number;
}

/** How {@link packAtoms} measures, bounds, and rescues a run of atoms. */
interface PackOptions {
    /** Upper bound on {@link PackOptions.measure} for any emitted chunk. */
    budget: number;
    /** Cost of the atoms as one joined chunk. */
    measure: (atoms: ReadonlyArray<string>) => number;
    /** Carry floor, in the same unit as {@link PackOptions.measure}. */
    overlap: number;
    /** Joined between atoms of one chunk. */
    separator: string;
    /** Split an atom that cannot fit the budget even alone. */
    splitOversized: (atom: string) => ReadonlyArray<string>;
}

/** One heading-delimited Markdown section plus the heading path above it. */
interface MarkdownSection {
    body: ReadonlyArray<string>;
    trail: ReadonlyArray<string>;
}

const DEFAULT_SIZE = 1000;
const DEFAULT_OVERLAP = 200;
const DEFAULT_MAX_TOKENS = 256;

/**
 * Sentence terminator followed by a whitespace character. Deliberately not
 * abbreviation-aware: the cost of an over-split ("Dr." ending a sentence) is a
 * slightly short chunk, while the cost of carrying a dictionary of
 * abbreviations is a per-language dependency this module exists to avoid.
 *
 * A single `\s` rather than `\s+` — runs of whitespace yield empty pieces the
 * caller already filters, and the unbounded quantifier is a backtracking
 * hazard for no gain.
 */
const SENTENCE_BOUNDARY = /(?<=[!.?])\s/u;

/** ATX heading line: 1–6 `#` then a space. Setext headings are not recognised. */
const ATX_HEADING = /^(#{1,6})\s(.*)$/u;

/** Opening or closing fence of a code block (``` or ~~~), with optional indent. */
const CODE_FENCE = /^ {0,3}(?:`{3,}|~{3,})/u;

const resolveOptions = (options: ChunkerOptions | undefined, label: string): { overlap: number; size: number } => {
    const size = options?.size ?? DEFAULT_SIZE;
    const overlap = options?.overlap ?? DEFAULT_OVERLAP;

    if (!Number.isInteger(size) || size < 1) {
        throw new RangeError(`${label}: \`size\` must be a positive integer`);
    }

    if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
        throw new RangeError(`${label}: \`overlap\` must be a non-negative integer smaller than \`size\``);
    }

    return { overlap, size };
};

/** Split trimmed prose into non-empty sentences. */
const toSentences = (text: string): string[] =>
    text
        .split(SENTENCE_BOUNDARY)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);

/** Character cost of joining `atoms` with `separator`. */
const joinedLength = (atoms: ReadonlyArray<string>, separator: string): number =>
    atoms.length === 0 ? 0 : atoms.reduce((sum, atom) => sum + atom.length, 0) + separator.length * (atoms.length - 1);

/**
 * The trailing atoms to carry into the next window: the shortest suffix
 * covering `overlap`.
 *
 * Bounded to a **strict** suffix (`carried.length < emitted.length`), because
 * carrying every atom would make the next window identical to the one just
 * emitted and the loop would never advance.
 */
const carryFrom = (emitted: ReadonlyArray<string>, options: PackOptions): string[] => {
    if (options.overlap === 0) {
        return [];
    }

    const carried: string[] = [];

    for (let index = emitted.length - 1; index >= 0 && carried.length < emitted.length - 1; index -= 1) {
        carried.unshift(emitted[index] as string);

        if (options.measure(carried) >= options.overlap) {
            break;
        }
    }

    return carried;
};

/**
 * Greedily pack `atoms` into budget-bounded chunks, carrying overlap between
 * them.
 *
 * The carry is dropped from the front whenever it would leave no room for the
 * incoming atom — without that, a window holding several atoms can carry more
 * than the budget minus one atom and emit an over-budget chunk.
 */
const packAtoms = (atoms: ReadonlyArray<string>, options: PackOptions): string[] => {
    const { budget, measure, separator, splitOversized } = options;
    const chunks: string[] = [];
    let current: string[] = [];

    const emit = (): void => {
        if (current.length > 0) {
            chunks.push(current.join(separator));
        }
    };

    for (const atom of atoms) {
        if (atom.trim().length === 0) {
            continue;
        }

        // An atom that cannot fit alone is hard-split. Emit first so its pieces
        // do not straddle unrelated content.
        if (measure([atom]) > budget) {
            emit();
            current = [];
            chunks.push(...splitOversized(atom));

            continue;
        }

        if (current.length > 0 && measure([...current, atom]) > budget) {
            emit();
            current = carryFrom(current, options);

            while (current.length > 0 && measure([...current, atom]) > budget) {
                current.shift();
            }
        }

        current.push(atom);
    }

    emit();

    return chunks.filter((chunk) => chunk.trim().length > 0);
};

/**
 * Split a Markdown document into heading-delimited sections, each tagged with
 * the heading path above it.
 *
 * `trail[depth - 1]` is the innermost heading at that level, and a new heading
 * truncates every deeper level — which is what keeps the trail a real ancestor
 * path rather than a log of every heading seen. Fenced code blocks are tracked
 * so a `#` comment inside a shell or Python fence never opens a section.
 */
const splitMarkdownSections = (text: string): MarkdownSection[] => {
    const sections: MarkdownSection[] = [];
    let trail: string[] = [];
    let body: string[] = [];
    let currentTrail: ReadonlyArray<string> = [];
    let inFence = false;

    const closeSection = (): void => {
        if (body.some((line) => line.trim().length > 0)) {
            sections.push({ body, trail: currentTrail });
        }

        body = [];
    };

    for (const line of text.split("\n")) {
        if (CODE_FENCE.test(line)) {
            inFence = !inFence;
            body.push(line);

            continue;
        }

        const heading = inFence ? undefined : (ATX_HEADING.exec(line) ?? undefined);

        if (heading === undefined) {
            body.push(line);

            continue;
        }

        closeSection();

        const depth = (heading[1] as string).length;
        const title = (heading[2] as string).trim();

        trail = [...trail.slice(0, depth - 1), `${"#".repeat(depth)} ${title}`];
        currentTrail = trail;
    }

    closeSection();

    return sections;
};

/**
 * Split on sentence boundaries, then greedily pack whole sentences into
 * `size`-bounded chunks. Prefer this over the fixed window for prose: chunks
 * start and end where the author ended a thought, which is what the embedding
 * model was trained on.
 * @experimental
 */
const sentenceChunker = (options?: ChunkerOptions): ((text: string) => ReadonlyArray<string>) => {
    const { overlap, size } = resolveOptions(options, "sentenceChunker");

    return (text: string): ReadonlyArray<string> => {
        const trimmed = text.trim();

        if (trimmed.length === 0) {
            return [];
        }

        return packAtoms(toSentences(trimmed), {
            budget: size,
            measure: (atoms) => joinedLength(atoms, " "),
            overlap,
            separator: " ",
            splitOversized: (atom) => fixedWindowChunks(atom, size, overlap),
        });
    };
};

/**
 * Split a Markdown document at its ATX headings, then pack each section's
 * sentences into `size`-bounded chunks.
 *
 * Every emitted chunk is prefixed with its **heading trail** (`# Guide > ##
 * Auth > ### OAuth`), so a chunk taken from deep inside a long document still
 * carries the context that says what it is about. That prefix is what makes a
 * mid-document chunk retrievable by a query naming its section rather than its
 * prose, and it is why this beats {@link sentenceChunker} on structured docs.
 * @experimental
 */
const markdownChunker = (options?: ChunkerOptions): ((text: string) => ReadonlyArray<string>) => {
    const { overlap, size } = resolveOptions(options, "markdownChunker");
    const packUnprefixed = sentenceChunker({ overlap, size });

    /** Sentence-pack one section's prose under `budget`, then prefix each piece. */
    const packSection = (sectionText: string, prefix: string): ReadonlyArray<string> => {
        const budget = size - prefix.length;

        // A trail longer than most of the budget would leave chunks that are
        // nearly all heading — fall back to un-prefixed pieces instead.
        if (budget < Math.ceil(size / 4)) {
            return packUnprefixed(sectionText);
        }

        return sentenceChunker({ overlap: Math.min(overlap, budget - 1), size: budget })(sectionText).map((piece) => `${prefix}${piece}`);
    };

    return (text: string): ReadonlyArray<string> => {
        if (text.trim().length === 0) {
            return [];
        }

        const chunks: string[] = [];

        for (const section of splitMarkdownSections(text)) {
            const sectionText = section.body.join("\n").trim();

            if (sectionText.length > 0) {
                chunks.push(...packSection(sectionText, section.trail.length > 0 ? `${section.trail.join(" > ")}\n\n` : ""));
            }
        }

        return chunks;
    };
};

/**
 * Pack sentences into chunks bounded by a real **token** count rather than a
 * character count. Use this when the embedding model's context window is the
 * binding constraint — a 512-token model silently truncates anything longer, so
 * the tail of an over-long chunk is embedded as if it were never written.
 * @experimental
 */
const tokenChunker = (options: TokenChunkerOptions): ((text: string) => ReadonlyArray<string>) => {
    const { countTokens } = options;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const overlapTokens = options.overlapTokens ?? 0;

    if (typeof countTokens !== "function") {
        throw new TypeError("tokenChunker: `countTokens` must be a function — pass your model's tokenizer (e.g. js-tiktoken)");
    }

    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
        throw new RangeError("tokenChunker: `maxTokens` must be a positive integer");
    }

    if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
        throw new RangeError("tokenChunker: `overlapTokens` must be a non-negative integer smaller than `maxTokens`");
    }

    /**
     * A sentence over budget on its own is split by characters, scaled by its
     * token overshoot — then any piece that STILL counts over `maxTokens` is
     * split again.
     *
     * The scaled window is only a guess: it assumes the atom's tokens are spread
     * evenly across its characters, and a run whose density is uneven (a long
     * URL or identifier followed by ordinary words, code, a table, CJK) breaks
     * that assumption badly enough to emit pieces several times over budget.
     * Emitting one is precisely the silent truncation at the embedding model
     * this chunker exists to prevent, so the guess is refined until every piece
     * measures within budget. The window shrinks by at least one character per
     * pass, so this terminates; a single character that still counts over budget
     * cannot be split further and is emitted as-is.
     */
    const splitOversized = (atom: string): ReadonlyArray<string> => {
        const pieces: string[] = [];
        // Depth-first over a stack, pushing sub-pieces in reverse, so the output
        // keeps the atom's own character order.
        const pending: string[] = [atom];

        while (pending.length > 0) {
            const piece = pending.pop() as string;
            const tokens = countTokens(piece);

            if (tokens <= maxTokens || piece.length <= 1) {
                pieces.push(piece);

                continue;
            }

            const scaled = Math.floor((piece.length * maxTokens) / Math.max(1, tokens));
            const pieceSize = Math.min(piece.length - 1, Math.max(1, scaled));
            const split = fixedWindowChunks(piece, pieceSize, 0);

            for (let index = split.length - 1; index >= 0; index -= 1) {
                pending.push(split[index] as string);
            }
        }

        return pieces;
    };

    return (text: string): ReadonlyArray<string> => {
        const trimmed = text.trim();

        if (trimmed.length === 0) {
            return [];
        }

        return packAtoms(toSentences(trimmed), {
            budget: maxTokens,
            measure: (atoms) => countTokens(atoms.join(" ")),
            overlap: overlapTokens,
            separator: " ",
            splitOversized,
        });
    };
};

export type { ChunkerOptions, TokenChunkerOptions };
export { markdownChunker, sentenceChunker, tokenChunker };
