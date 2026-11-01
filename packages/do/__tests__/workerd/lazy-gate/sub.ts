import { recordEvaluation } from "./procedures";

// eslint-disable-next-line vitest/require-hook -- module evaluation is what this fixture counts
recordEvaluation("import/sub");

export { read as default } from "./procedures";
