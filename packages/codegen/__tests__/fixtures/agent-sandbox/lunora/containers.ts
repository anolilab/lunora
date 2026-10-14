import { defineContainer } from "@lunora/container";

// The container the `containerTool("worker")` above routes to (`ctx.containers.worker`).
export const worker = defineContainer({
    image: "./containers/worker/Dockerfile",
});
