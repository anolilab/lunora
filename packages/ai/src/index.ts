export { default as createAi } from "./create-ai";
export type { AiBindingLike, AiGatewayOptions, EmbeddingModelInput, LunoraAi, LunoraAiOptions, ModelInput, WorkersAiProviderLike } from "./types";

// Re-export the AI SDK primitives apps reach for, so `@lunora/ai` is a single
// import for the whole inference surface. These are provider-agnostic — pass
// them a Workers AI model (via `ctx.ai.model(...)`) or any other AI SDK model.
export type { EmbeddingModel, LanguageModel } from "ai";
export { embed, embedMany, generateObject, generateText, hasToolCall, jsonSchema, streamObject, streamText, tool } from "ai";
// The Workers AI provider factory, for callers who want to build/configure the
// provider themselves before handing it to `createAi({ provider })`.
export { createWorkersAI } from "workers-ai-provider";
