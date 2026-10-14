/**
 * Like `renderJsonData`, but wrapped in a memoising thunk so the JSON is parsed
 * on first call instead of at module evaluation. For admin-only payloads a
 * Worker isolate would otherwise parse on every cold start. Call sites read
 * `LUNORA_X()`.
 */
const renderLazyJsonData = (value: unknown, type: string): string =>
    `((): (() => ${type}) => { let cached: ${type} | undefined; return () => (cached ??= JSON.parse(${JSON.stringify(JSON.stringify(value))}) as ${type}); })()`;

export default renderLazyJsonData;
