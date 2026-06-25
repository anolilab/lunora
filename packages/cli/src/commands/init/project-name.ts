/**
 * A playful lunar-themed default project name (create-astro generates a fun name
 * too). Used as the placeholder/default in the `init` name prompt so an empty
 * submit lands on something nicer than a static `lunora-app`. Output is always a
 * valid directory + npm package name (lowercase, hyphenated), so it can be
 * accepted as-is.
 */

/** Moon/space-flavored adjectives — the first half of the name. */
const ADJECTIVES: ReadonlyArray<string> = [
    "lunar",
    "silver",
    "silent",
    "waning",
    "waxing",
    "crescent",
    "cosmic",
    "stellar",
    "orbital",
    "gibbous",
    "twilight",
    "midnight",
    "shimmering",
    "drifting",
    "weightless",
];

/** Moon/space-flavored nouns — the second half of the name. */
const NOUNS: ReadonlyArray<string> = [
    "moon",
    "tide",
    "crater",
    "comet",
    "eclipse",
    "halo",
    "orbit",
    "nebula",
    "voyager",
    "lander",
    "rover",
    "beacon",
    "harbor",
    "meadow",
    "fox",
];

/** Pick a random element. Cosmetic only — not a security-sensitive draw. */
const pick = <T>(items: ReadonlyArray<T>): T =>
    // eslint-disable-next-line sonarjs/pseudo-random -- cosmetic default project name, not a security decision.
    items[Math.floor(Math.random() * items.length)] as T;

/** Generate a fresh lunar name like `silver-moon` or `drifting-comet`. */
const generateProjectName = (): string => `${pick(ADJECTIVES)}-${pick(NOUNS)}`;

export default generateProjectName;
