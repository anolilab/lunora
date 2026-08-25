/**
 * The Studio assistant's `loadKnowledge` tool — lookup over the documentation
 * digest in {@link file://./ai-knowledge-data.ts}.
 *
 * **Why this exists.** Every other tool the assistant has reads the OPERATOR's
 * deployment: their schema, their logs, their advisories, their rows. None of
 * them says anything about Lunora, so a question like "how do I add an index" was
 * answered from whatever the model remembered about some other framework — it
 * invented API names with total confidence, which is the worst possible failure
 * for a console that then offers to insert the result into an editor.
 *
 * **Why an index rather than prose.** The digest is generated from
 * `apps/docs/src/content/docs` by `scripts/build-ai-knowledge.js` and carries a
 * page's title, its reviewed one-sentence `description`, and its `##` headings —
 * which in these docs are largely API names, so the outline doubles as a symbol
 * list. It is not the pages themselves: the concept docs alone are ~450 KB, one
 * tool result is capped at 2,000 characters by `fitToBudget`, and every byte here
 * ships inside every deployed Worker. What the model gets is enough to know what
 * exists, what it is called, and which URL to cite — and the system prompt tells
 * it to say so rather than guess when the index does not name a thing.
 *
 * Like its neighbours this is deliberately **not** a package: consumers import it
 * by relative path and the bundler inlines it. Keep it zero-dependency.
 */
import { DOC_TOPICS } from "./ai-knowledge-data";

/** One page of the digest, as the generator writes it. Derived so there is no hand-kept second copy of the shape. */
type DocTopic = (typeof DOC_TOPICS)[number];

/** One page as the model receives it — the digest entry plus the URL it should cite. */
export interface KnowledgeEntry extends DocTopic {
    readonly url: string;
}

/** Where the digest's ids resolve. The docs site's canonical origin (`apps/docs/site.config.ts`). */
const DOCS_ORIGIN = "https://lunora.sh/docs/";

/** Pages returned for a matching topic. Four fits the tool-result budget with room for the longest summaries. */
const MAX_MATCHES = 4;

/** Shortest query word that carries meaning. Below this every page matches "in", "a", "of". */
const MIN_TERM_LENGTH = 3;

/** Cap on a caller-supplied topic, so an enormous one cannot turn the scan quadratic. */
const TOPIC_CAP = 200;

/**
 * Score weights, highest first.
 *
 * A term in the SLUG or TITLE is the operator naming the page; a term in a
 * HEADING is them naming a section or an API on it; a term in the summary is the
 * weakest signal, since a summary mentions its neighbours. The exact numbers are
 * not load-bearing — the ordering between them is.
 */
const WEIGHT_ID = 4;
const WEIGHT_TITLE = 3;
const WEIGHT_HEADING = 2;
const WEIGHT_SUMMARY = 1;

/** Split a phrase into lowercase terms worth matching on. */
const terms = (phrase: string): string[] =>
    phrase
        .slice(0, TOPIC_CAP)
        .toLowerCase()
        .split(/[^a-z0-9.]+/u)
        .filter((term) => term.length >= MIN_TERM_LENGTH);

/** How well one page answers `wanted`. Substring rather than word matching, so `index` finds `indexes`. */
const score = (topic: DocTopic, wanted: ReadonlyArray<string>): number => {
    const id = topic.id.toLowerCase();
    const title = topic.title.toLowerCase();
    const summary = topic.summary.toLowerCase();
    const headings = topic.headings.map((heading) => heading.toLowerCase());

    let total = 0;

    for (const term of wanted) {
        if (id.includes(term)) {
            total += WEIGHT_ID;
        }

        if (title.includes(term)) {
            total += WEIGHT_TITLE;
        }

        if (headings.some((heading) => heading.includes(term))) {
            total += WEIGHT_HEADING;
        }

        if (summary.includes(term)) {
            total += WEIGHT_SUMMARY;
        }
    }

    return total;
};

/**
 * The documentation pages best answering `topic`.
 *
 * A topic matching nothing returns the TABLE OF CONTENTS — every page's slug,
 * and nothing else — rather than an empty list. An empty result is a dead end
 * the model can only answer from memory, which is the exact failure this tool
 * exists to prevent, whereas the slugs let it ask again in a word the digest
 * actually uses. Bare strings, not the entry objects: the objects' own keys cost
 * more than the ids do, and `fitToBudget` trims from the END, so the fatter shape
 * bought a contents page that stopped at the letter C.
 */
export const searchKnowledge = (topic: unknown): { readonly entries: ReadonlyArray<KnowledgeEntry | string> } => {
    const wanted = terms(typeof topic === "string" ? topic : "");

    const ranked =
        wanted.length === 0
            ? []
            : DOC_TOPICS.map((candidate) => {
                  return { candidate, rank: score(candidate, wanted) };
              })
                  .filter((scored) => scored.rank > 0)
                  // Ties broken by id so the same topic always returns the same pages —
                  // `Array.prototype.sort` is stable, and `DOC_TOPICS` is already id-ordered.
                  .sort((left, right) => right.rank - left.rank)
                  .slice(0, MAX_MATCHES)
                  .map((scored): KnowledgeEntry => {
                      return { ...scored.candidate, url: `${DOCS_ORIGIN}${scored.candidate.id}` };
                  });

    return { entries: ranked.length === 0 ? DOC_TOPICS.map((candidate) => candidate.id) : ranked };
};
