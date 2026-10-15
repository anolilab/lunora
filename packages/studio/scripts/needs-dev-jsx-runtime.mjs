/**
 * Whether a bundle graph needs React's development JSX runtime.
 *
 * Its own module, rather than a helper inside `build-standalone.mjs`, because
 * that script does a top-level `await build(...)` — importing it from a test
 * would run a full esbuild bundle as a side effect. The decision is what broke,
 * so the decision is what needs to be reachable from a test.
 * @param {readonly string[]} inputs Module paths, as an esbuild metafile lists them.
 * @returns {boolean} True when React's dev JSX runtime is in the graph.
 */
const needsDevJsxRuntime = (inputs) => inputs.some((input) => input.includes("react-jsx-dev-runtime") || input.includes("react/jsx-dev-runtime"));

export default needsDevJsxRuntime;
