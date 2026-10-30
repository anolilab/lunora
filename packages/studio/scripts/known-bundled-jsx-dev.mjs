/**
 * The one third-party `jsxDEV` block a production standalone bundle may contain.
 *
 * `hast-util-to-jsx-runtime` (pulled in by markdown rendering) accepts a
 * `development` option and, only when a caller sets it, insists on a `jsxDEV`
 * factory in its options. Its production build therefore carries this guard, its
 * error message and the pass-through of `options.jsxDEV`, and nothing else. The
 * shape is matched whole, with the options identifier back-referenced, so a real
 * React dev factory call such as `(0,t.jsxDEV)(...)` cannot match it. A different
 * hast layout, or any extra occurrence, leaves `jsxDEV` text behind for the caller.
 */
const KNOWN_HAST_JSX_DEV_BLOCK =
    /typeof ([\w$]+)\.jsxDEV!==?"function"\)throw new TypeError\("Expected `jsxDEV` in options when `development: true`"\);[\w$]+=[\w$]+\([\w$]+,\1\.jsxDEV\)/g;

/**
 * `source` with the known hast block removed. A bundled artifact is checked for
 * `jsxDEV` after this, so only that exact shape is exempt.
 * @param {string} source Bundle text, as read from disk.
 * @returns {string} The same text with the known block removed.
 */
const stripKnownBundledJsxDev = (source) => source.replaceAll(KNOWN_HAST_JSX_DEV_BLOCK, "");

export default stripKnownBundledJsxDev;
