#!/usr/bin/env node
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAPI } from "hetzner-sdk-ts";
import { registerTools } from "./register-tools.js";
import { registerDnsTools } from "./dns-tools.js";
import { registerExtraTools } from "./extra-tools.js";
import { registerStorageBoxTools } from "./storage-box-tools.js";
import { registerCertificateTools } from "./certificate-tools.js";
import { registerImageTools } from "./image-tools.js";
import { registerServerOpsTools } from "./server-ops-tools.js";
import { registerActionGapTools } from "./action-gap-tools.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

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
    { name: "hetzner-cloud", version: "0.3.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

// Tool groups. HCLOUD_TOOLSETS (comma-separated) limits which load, for clients with
// tool-count limits; default is all. "core" is always loaded.
const TOOLSETS: Record<string, Array<(s: McpServer) => void>> = {
    core: [registerTools, registerExtraTools, registerActionGapTools],
    dns: [registerDnsTools],
    images: [registerImageTools],
    ops: [registerServerOpsTools],
    certificates: [registerCertificateTools],
    storage_boxes: [registerStorageBoxTools],
};
const requested = (process.env.HCLOUD_TOOLSETS ?? "")
    .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
const unknown = requested.filter((t) => t !== "all" && !(t in TOOLSETS));
if (unknown.length) {
    console.error(`Error: unknown HCLOUD_TOOLSETS ${unknown.join(", ")}. Valid: all, ${Object.keys(TOOLSETS).join(", ")}`);
    process.exit(1);
}
const enabled = requested.length === 0 || requested.includes("all")
    ? Object.keys(TOOLSETS)
    : ["core", ...requested.filter((t) => t !== "core")];
for (const name of enabled) for (const register of TOOLSETS[name]) register(server);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Hetzner MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
