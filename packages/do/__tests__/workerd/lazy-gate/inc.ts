import { recordEvaluation } from "./procedures";

// eslint-disable-next-line vitest/require-hook -- module evaluation is what this fixture counts
recordEvaluation("import/inc");

export { bump as default } from "./procedures";
