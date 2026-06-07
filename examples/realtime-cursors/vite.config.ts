import { cirrus } from "@cirrus/vite";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [cirrus()],
    server: {
        port: 5174,
    },
});
