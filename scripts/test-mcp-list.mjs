/**
 * Integration test: spawn the MCP server and call list_locations via the MCP client.
 * Run from project root: node scripts/test-mcp-list.mjs
 * Uses HCLOUD_TOKEN from environment or .env.
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const token = process.env.HCLOUD_TOKEN;
if (!token) {
    console.error("Error: HCLOUD_TOKEN environment variable is required");
    process.exit(1);
}

const transport = new StdioClientTransport({
    command: "node",
    args: [join(projectRoot, "dist/index.js")],
    env: { ...process.env, HCLOUD_TOKEN: token },
    cwd: projectRoot,
});

const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
);

async function main() {
    console.log("Connecting to MCP server...");
    await client.connect(transport);

    console.log("Calling list_locations...");
    const result = await client.callTool(
        { name: "list_locations", arguments: {} },
        CallToolResultSchema
    );
    console.log("isError:", result.isError);
    if (result.content?.length) {
        for (const part of result.content) {
            if (part.type === "text") {
                const preview = part.text.slice(0, 500);
                console.log("content (preview):", preview + (part.text.length > 500 ? "..." : ""));
            }
        }
    } else {
        console.log("content:", result.content);
    }

    await client.close();
    process.exit(result.isError ? 1 : 0);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
