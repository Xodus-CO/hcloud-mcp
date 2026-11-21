// Hetzner Robot (dedicated servers) tools, issue #21. Opt-in: registered only when
// HROBOT_USER and HROBOT_PASSWORD are set (see index.ts). Cancellation, orders and
// billing are deliberately out of scope.
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { robotList, robotRequest } from "./robot-api.js";
import { ADDITIVE, ADDITIVE_IDEMPOTENT, DESTRUCTIVE, DESTRUCTIVE_IDEMPOTENT, READ_ONLY, json, withToolError } from "./tool-helpers.js";

const serverNumber = z.number().int().positive().describe("Robot server number (server_number from robot_list_servers)");
const ipArg = z.string().refine((v) => isIP(v) !== 0, "Must be an IPv4 or IPv6 address").describe("IP address");
const serverIpFilter = z.string().refine((v) => isIP(v) !== 0, "Must be an IP address").optional()
    .describe("Only entries assigned to the server with this main IP");

export function registerRobotTools(server: McpServer) {
    // --- Reads ---
    server.registerTool(
        "robot_list_servers",
        {
            description: "List Hetzner Robot dedicated servers (not Cloud servers): number, name, main IP, product, datacenter, status, paid_until",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async () => withToolError(async () => json(await robotList("/server", "server"))),
    );

    server.registerTool(
        "robot_get_server",
        {
            description: "Get one Robot dedicated server by server number, including its IPs and subnets",
            inputSchema: { server_number: serverNumber },
            annotations: READ_ONLY,
        },
        async ({ server_number }) => withToolError(async () =>
            json((await robotRequest("GET", `/server/${server_number}`)).server)),
    );

    server.registerTool(
        "robot_list_ips",
        {
            description: "List Robot IP addresses (single IPv4s) with their server, locked and traffic-warning settings",
            inputSchema: { server_ip: serverIpFilter },
            annotations: READ_ONLY,
        },
        async ({ server_ip }) => withToolError(async () => json(await robotList("/ip", "ip", { server_ip }))),
    );

    server.registerTool(
        "robot_get_ip",
        {
            description: "Get one Robot IP address",
            inputSchema: { ip: ipArg },
            annotations: READ_ONLY,
        },
        async ({ ip }) => withToolError(async () =>
            json((await robotRequest("GET", `/ip/${encodeURIComponent(ip)}`)).ip)),
    );

    server.registerTool(
        "robot_list_subnets",
        {
            description: "List Robot subnets (IPv6 /64s and additional IPv4 subnets)",
            inputSchema: { server_ip: serverIpFilter },
            annotations: READ_ONLY,
        },
        async ({ server_ip }) => withToolError(async () => json(await robotList("/subnet", "subnet", { server_ip }))),
    );

    server.registerTool(
        "robot_get_subnet",
        {
            description: "Get one Robot subnet by its network address (e.g. 2a01:4f8:111:4221::)",
            inputSchema: { net_ip: ipArg.describe("Subnet network address, without the mask") },
            annotations: READ_ONLY,
        },
        async ({ net_ip }) => withToolError(async () =>
            json((await robotRequest("GET", `/subnet/${encodeURIComponent(net_ip)}`)).subnet)),
    );

    server.registerTool(
        "robot_list_rdns",
        {
            description: "List Robot reverse DNS (PTR) entries, optionally only those of one server",
            inputSchema: { server_ip: serverIpFilter },
            annotations: READ_ONLY,
        },
        async ({ server_ip }) => withToolError(async () => json(await robotList("/rdns", "rdns", { server_ip }))),
    );

    server.registerTool(
        "robot_get_rdns",
        {
            description: "Get the reverse DNS (PTR) entry of one Robot IP. Errors with RDNS_NOT_FOUND if none is set",
            inputSchema: { ip: ipArg },
            annotations: READ_ONLY,
        },
        async ({ ip }) => withToolError(async () =>
            json((await robotRequest("GET", `/rdns/${encodeURIComponent(ip)}`)).rdns)),
    );

    server.registerTool(
        "robot_get_traffic",
        {
            description: "Traffic (GB in/out/sum) for Robot IPs or subnets. type=day: hourly data within a day (from/to like 2026-11-01T00); month: daily data (2026-11-01); year: monthly data (2026-11). Data only exists once the period has passed. Give at least one ip or subnet",
            inputSchema: {
                type: z.enum(["day", "month", "year"]),
                from: z.string().describe("Start: YYYY-MM-DDTHH for day, YYYY-MM-DD for month, YYYY-MM for year"),
                to: z.string().describe("End, same format as from"),
                ips: z.array(ipArg).optional().describe("IP addresses to query"),
                subnets: z.array(ipArg).optional().describe("Subnet network addresses to query"),
                single_values: z.boolean().optional().describe("Return one value per hour/day/month instead of a sum over the interval"),
            },
            annotations: READ_ONLY,
        },
        async ({ type, from, to, ips, subnets, single_values }) => withToolError(async () => {
            if (!ips?.length && !subnets?.length) throw new Error("Pass at least one of ips or subnets");
            const res = await robotRequest("POST", "/traffic", {
                form: { type, from, to, "ip": ips, "subnet": subnets, single_values: single_values ? "true" : undefined },
            });
            return json(res.traffic);
        }),
    );

    server.registerTool(
        "robot_get_boot_config",
        {
            description: "Boot configuration of a Robot server: shows whether the Rescue System is active (rescue.active), its available OS and authorized keys, plus other boot options (linux install, vnc, windows). The rescue password is only returned right after robot_enable_rescue",
            inputSchema: { server_number: serverNumber },
            annotations: READ_ONLY,
        },
        async ({ server_number }) => withToolError(async () =>
            json((await robotRequest("GET", `/boot/${server_number}`)).boot)),
    );

    server.registerTool(
        "robot_get_reset_options",
        {
            description: "Reset options of a Robot server: available types (sw = software/ACPI, hw = hardware reset, power = power button, man = manual technician) and operating_status where supported. Omit server_number to list every server that has a reset option",
            inputSchema: { server_number: serverNumber.optional() },
            annotations: READ_ONLY,
        },
        async ({ server_number }) => withToolError(async () =>
            server_number === undefined
                ? json(await robotList("/reset", "reset"))
                : json((await robotRequest("GET", `/reset/${server_number}`)).reset)),
    );

    // --- Actions ---
    server.registerTool(
        "robot_enable_rescue",
        {
            description: "Activate the Robot Rescue System for the NEXT boot of a dedicated server. Does not reboot: follow with robot_reset_server once the user agrees. Returns a root password (treat as a secret; show only to the user). Pass authorized_keys (fingerprints of keys stored in Robot) to log in by key. Rescue deactivates itself after the first boot into it",
            inputSchema: {
                server_number: serverNumber,
                os: z.enum(["linux", "vkvm"]).optional().describe("Rescue OS (default linux)"),
                authorized_keys: z.array(z.string().min(1)).optional().describe("SSH key fingerprints (as listed in Robot, e.g. 56:29:99:...) to authorize"),
                keyboard: z.string().optional().describe("Keyboard layout (default us)"),
            },
            annotations: DESTRUCTIVE,
        },
        async ({ server_number, os, authorized_keys, keyboard }) => withToolError(async () =>
            json((await robotRequest("POST", `/boot/${server_number}/rescue`, {
                form: { os: os ?? "linux", authorized_key: authorized_keys, keyboard },
            })).rescue)),
    );

    server.registerTool(
        "robot_disable_rescue",
        {
            description: "Deactivate the Robot Rescue System so the server boots from its own disk. Does not reboot",
            inputSchema: { server_number: serverNumber },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ server_number }) => withToolError(async () =>
            json((await robotRequest("DELETE", `/boot/${server_number}/rescue`)).rescue)),
    );

    server.registerTool(
        "robot_reset_server",
        {
            description: "Reset (reboot) a dedicated server NOW; running services are interrupted and there is no undo. sw = software/ACPI reset, hw = hardware reset, power = press the power button, man = manual reset by a data centre technician (can take a while; only one at a time). Check robot_get_reset_options for the types the server supports. Robot allows only 50 resets per hour. Confirm with the user first",
            inputSchema: {
                server_number: serverNumber,
                type: z.enum(["sw", "hw", "power", "man"]),
            },
            annotations: DESTRUCTIVE,
        },
        async ({ server_number, type }) => withToolError(async () =>
            json((await robotRequest("POST", `/reset/${server_number}`, { form: { type } })).reset)),
    );

    server.registerTool(
        "robot_set_rdns",
        {
            description: "Create or replace the reverse DNS (PTR) entry of a Robot IP",
            inputSchema: { ip: ipArg, ptr: z.string().min(1).describe("Hostname, e.g. mail.example.com") },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        // POST creates or updates; PUT would fail with RDNS_ALREADY_EXISTS on an existing entry.
        async ({ ip, ptr }) => withToolError(async () =>
            json((await robotRequest("POST", `/rdns/${encodeURIComponent(ip)}`, { form: { ptr } })).rdns)),
    );

    server.registerTool(
        "robot_delete_rdns",
        {
            description: "Delete the reverse DNS (PTR) entry of a Robot IP",
            inputSchema: { ip: ipArg },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ ip }) => withToolError(async () => {
            await robotRequest("DELETE", `/rdns/${encodeURIComponent(ip)}`);
            return json({ deleted: true, ip });
        }),
    );

    server.registerTool(
        "robot_wake_on_lan",
        {
            description: "Send a Wake-on-LAN packet to a dedicated server (powers on a server that is off). Robot allows 10 per hour",
            inputSchema: { server_number: serverNumber },
            annotations: ADDITIVE,
        },
        async ({ server_number }) => withToolError(async () =>
            json((await robotRequest("POST", `/wol/${server_number}`, { form: {} })).wol)),
    );
}
