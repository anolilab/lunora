import { defineAgent } from "@lunora/agent";
import { browserTool, containerTool } from "@lunora/agent/sandbox";

// A batteries-included agent: codegen registers the `sandbox:invoke` dispatcher,
// provisions the BROWSER binding (browserTool), and rides the declared container
// (containerTool). `browserTool` still needs a `config.browser` thunk on
// createShardDO() (like any ctx.browser user) — codegen wires the binding, not
// the optional @cloudflare/playwright launch peer.
export const researcher = defineAgent({
    instructions: "Research on the web and in the sandbox container.",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    tools: {
        browser: browserTool(),
        sandbox: containerTool("worker"),
    },
});
