import { recordEvaluation } from "./procedures";

// eslint-disable-next-line vitest/require-hook -- module evaluation is what this fixture counts
recordEvaluation("import/warm");

export { bump as default } from "./procedures";
