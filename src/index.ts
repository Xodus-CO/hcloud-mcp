#!/usr/bin/env node
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAPI } from "hetzner-sdk-ts";
import { registerTools } from "./register-tools.js";

// Load .env from project root (parent of dist) so IDE-spawned server finds token when env isn't set
if (!process.env.HCLOUD_TOKEN) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    loadEnv({ path: join(__dirname, "..", ".env") });
}

const token = process.env.HCLOUD_TOKEN;
if (!token) {
    console.error("Error: HCLOUD_TOKEN environment variable is required");
    process.exit(1);
}

OpenAPI.TOKEN = token;

const server = new McpServer(
    { name: "hetzner-cloud", version: "0.1.0" },
    { capabilities: { tools: {} } }
);

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
