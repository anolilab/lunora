/**
 * The one shape every count-like option in this package accepts (`maxTurns`,
 * `maxPolls`, `maxSteps`, `voice.maxTurns`, a delegation depth): an integer
 * of at least 1. A narrowing guard so callers never need an `as number`.
 */
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

export default isPositiveInteger;
