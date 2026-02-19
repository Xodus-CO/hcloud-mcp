import { McpServer } from "./mcp-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAPI } from "hetzner-sdk-ts";
import { registerTools } from "./register-tools.js";

const token = process.env.HCLOUD_TOKEN;
if (!token) {
    console.error("Error: HCLOUD_TOKEN environment variable is required");
    process.exit(1);
}

OpenAPI.TOKEN = token;

const server = new McpServer({
    name: "hetzner-cloud",
    version: "0.1.0",
});

registerTools(server);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Hetzner MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
