#!/usr/bin/env node
/**
 * Launcher that runs the MCP server from the project directory regardless of CWD.
 * Use an absolute path in MCP config when Cursor runs from a different directory
 * (e.g. dev containers where CWD may be /root):
 *   "args": ["/path/to/hcloud-mcp/run.js"]
 */
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);
await import("./dist/index.js");
