// satori is pinned below 0.33.5 (its later releases compile wasm at runtime, which workerd refuses),
// so it does not escape text into its SVG (GHSA-wx4j-mvgx-mqwp). Query parameters reach it from
// anyone, so the characters that open markup or an attribute are dropped or swapped for their
// typographic forms, which keeps titles like "Lunora's take" readable.
const MARKUP_OPENERS = /[<>]/gu;

const MAX_LENGTH = 200;

const plainOgText = (value: string): string => value.replaceAll(MARKUP_OPENERS, "").replaceAll("'", "’").replaceAll('"', "”").slice(0, MAX_LENGTH);

export default plainOgText;
