// satori is pinned below 0.33.5 (its later releases compile wasm at runtime, which workerd refuses),
// so it does not escape text into its SVG (GHSA-wx4j-mvgx-mqwp). Query parameters reach it from
// anyone, so markup characters are dropped before rendering.
const MARKUP_CHARACTERS = /["&'<>]/gu;

const MAX_LENGTH = 200;

const plainOgText = (value: string): string => value.replaceAll(MARKUP_CHARACTERS, "").slice(0, MAX_LENGTH);

export default plainOgText;
