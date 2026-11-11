/**
 * Offline smoke test (no Hetzner API calls, no real token): starts the built server
 * over stdio and checks that it initializes, sends instructions, registers tools
 * without duplicate names, declares MCP annotations on every tool, and honours
 * HCLOUD_TOOLSETS. Used by CI.
 *
 * Usage: npm run build && node scripts/smoke-mcp.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exit(1); };

async function start(env = {}) {
    const client = new Client({ name: "smoke", version: "0" });
    await client.connect(new StdioClientTransport({
        command: "node", args: ["dist/index.js"],
        env: { PATH: process.env.PATH, HCLOUD_TOKEN: "smoke-test-dummy-token", ...env },
        stderr: "ignore",
    }));
    const { tools } = await client.listTools();
    const info = { version: client.getServerVersion()?.version, instructions: client.getInstructions() ?? "", tools };
    await client.close();
    return info;
}

const all = await start();
if (all.version !== pkg.version) fail(`server version ${all.version} != package.json ${pkg.version}`);
if (all.instructions.length < 200) fail("server instructions missing or too short");
const names = all.tools.map((t) => t.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) fail(`duplicate tool names: ${dupes.join(", ")}`);
if (names.length < 150) fail(`expected >=150 tools, got ${names.length}`);
for (const t of all.tools) if (!t.description || t.description.length < 10) fail(`tool ${t.name} has no description`);
console.log(`ok   all toolsets: v${all.version}, ${names.length} tools, instructions ${all.instructions.length} chars`);

// Tool count is pinned: adding or removing a tool should be a deliberate change here.
const EXPECTED_TOOLS = 162;
if (names.length !== EXPECTED_TOOLS) fail(`expected ${EXPECTED_TOOLS} tools, got ${names.length}`);

// MCP annotations: every tool declares them explicitly.
const ALSO_DESTRUCTIVE = [
    "power_off_server", "change_server_type", "import_zonefile", "set_rrset_records", "set_firewall_rules",
    "disable_server_backups", "disable_load_balancer_public_interface", "change_protection",
];
const counts = { readOnly: 0, destructive: 0, idempotent: 0 };
for (const t of all.tools) {
    const a = t.annotations;
    if (!a) fail(`tool ${t.name} has no annotations`);
    if (a.openWorldHint !== true) fail(`tool ${t.name}: openWorldHint must be true (external API)`);
    if (typeof a.readOnlyHint !== "boolean") fail(`tool ${t.name}: readOnlyHint not set`);
    // destructiveHint defaults to true in the spec, so mutating tools must set it explicitly.
    if (!a.readOnlyHint && (typeof a.destructiveHint !== "boolean" || typeof a.idempotentHint !== "boolean")) {
        fail(`tool ${t.name}: mutating tool must set destructiveHint and idempotentHint`);
    }
    if (/^(list|get|export)_/.test(t.name) && a.readOnlyHint !== true) fail(`tool ${t.name} should be readOnlyHint`);
    if ((/^(delete|remove|detach|unassign|reset|rollback|rebuild)_/.test(t.name) || ALSO_DESTRUCTIVE.includes(t.name)) && a.destructiveHint !== true) {
        fail(`tool ${t.name} should be destructiveHint`);
    }
    if (/^delete_/.test(t.name) && a.idempotentHint !== true) fail(`tool ${t.name} should be idempotentHint`);
    if (a.readOnlyHint) counts.readOnly++;
    if (!a.readOnlyHint && a.destructiveHint) counts.destructive++;
    if (!a.readOnlyHint && a.idempotentHint) counts.idempotent++;
}
console.log(`ok   annotations: ${counts.readOnly} readOnly, ${counts.destructive} destructive, ${counts.idempotent} idempotent mutations`);

const core = await start({ HCLOUD_TOOLSETS: "core" });
const dns = await start({ HCLOUD_TOOLSETS: "dns" });
if (!(core.tools.length < dns.tools.length && dns.tools.length < names.length)) {
    fail(`toolset sizes not ordered: core ${core.tools.length}, dns ${dns.tools.length}, all ${names.length}`);
}
if (!dns.tools.some((t) => t.name === "list_zones") || core.tools.some((t) => t.name === "list_zones")) fail("dns toolset wiring");
console.log(`ok   HCLOUD_TOOLSETS: core ${core.tools.length}, core+dns ${dns.tools.length}`);
console.log("smoke passed");
