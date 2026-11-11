import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ADDITIVE, ADDITIVE_IDEMPOTENT, DESTRUCTIVE, DESTRUCTIVE_IDEMPOTENT, READ_ONLY, listAll, withToolError } from "./tool-helpers.js";
import { hcloudRequest } from "./hcloud-api.js";

// Firewall rule: direction, protocol required; source_ips for 'in', destination_ips for 'out'; port for tcp/udp
const firewallRuleSchema = z.object({
    direction: z.enum(["in", "out"]),
    protocol: z.enum(["tcp", "udp", "icmp", "esp", "gre"]),
    source_ips: z.array(z.string()).optional().describe("CIDRs for direction=in; host bits must be zero (10.0.1.0/24, not 10.0.1.42/24; single host 192.0.2.2/32)"),
    destination_ips: z.array(z.string()).optional().describe("CIDRs for direction=out; host bits must be zero"),
    port: z.string().optional(),
    description: z.string().nullable().optional(),
});

const firewallApplyToSchema = z.object({
    type: z.enum(["server", "label_selector"]),
    server: z.object({ id: z.number() }).optional(),
    label_selector: z.object({ selector: z.string() }).optional(),
});

export function registerTools(server: McpServer) {
    // --- Servers ---
    server.registerTool(
        "list_servers",
        {
            description: "List all servers",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/servers", { query: p }), "servers");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "get_server",
        {
            description: "Get a single server by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/servers/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response.server, null, 2) }] };
        })
    );

    server.registerTool(
        "create_server",
        {
            description: "Create a new server",
            inputSchema: {
                name: z.string(),
                server_type: z.string(),
                image: z.string(),
                location: z.string().optional().describe("Location name or ID, e.g. fsn1, nbg1, hel1, ash, hil, sin. Check list_server_types locations[].available first"),
                start_after_create: z.boolean().optional(),
                ssh_keys: z.array(z.union([z.string(), z.number()])).optional().describe("List of SSH key names or IDs"),
                firewalls: z.array(z.object({ firewall: z.number() })).optional(),
                networks: z.array(z.number()).optional(),
                placement_group: z.number().optional().describe("ID of placement group"),
                public_net: z
                    .object({
                        enable_ipv4: z.boolean().optional(),
                        enable_ipv6: z.boolean().optional(),
                        ipv4: z.number().nullable().optional(),
                        ipv6: z.number().nullable().optional(),
                    })
                    .optional(),
                user_data: z.string().optional().describe("Cloud-Init user data (max 32KiB)"),
                volumes: z.array(z.number()).optional().describe("Volume IDs to attach at creation"),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                server_type: args.server_type,
                image: args.image,
                location: args.location,
                start_after_create: args.start_after_create,
                ssh_keys: args.ssh_keys?.map((k) => (typeof k === "number" ? String(k) : k)),
                firewalls: args.firewalls,
                networks: args.networks,
                placement_group: args.placement_group,
                public_net: args.public_net,
                user_data: args.user_data,
                volumes: args.volumes,
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/servers", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_server",
        {
            description: "Delete a server",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("DELETE", `/servers/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "change_server_type",
        {
            description: "Change the type of a server (scales resources). Server must be powered off.",
            inputSchema: {
                id: z.number(),
                server_type: z.string().describe("New server type (e.g. cx22)"),
                upgrade_disk: z.boolean().default(true).describe("Whether to upgrade disk size. If true, cannot downgrade later."),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, server_type, upgrade_disk }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/change_type`, { body: { server_type, upgrade_disk } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "power_on_server",
        {
            description: "Power on a server",
            inputSchema: { id: z.number() },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/poweron`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "power_off_server",
        {
            description: "Power off a server (hard)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/poweroff`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "reboot_server",
        {
            description: "Reboot a server (soft)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/reboot`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "shutdown_server",
        {
            description: "Shutdown a server (soft)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/shutdown`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "reset_server",
        {
            description: "Reset a server (hard)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/reset`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_server",
        {
            description: "Update a server (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/servers/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "attach_iso",
        {
            description: "Attach an ISO to a server",
            inputSchema: {
                id: z.number(),
                iso: z.string().describe("ID or name of the ISO"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, iso }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/attach_iso`, { body: { iso } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "detach_iso",
        {
            description: "Detach an ISO from a server",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/detach_iso`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "attach_server_to_network",
        {
            description: "Attach a server to a network",
            inputSchema: {
                id: z.number(),
                network: z.number().describe("ID of the network"),
                ip: z.string().optional().describe("IP to request, otherwise auto-assigned"),
                alias_ips: z.array(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, network, ip, alias_ips }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/attach_to_network`, { body: { network, ip, alias_ips } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "detach_server_from_network",
        {
            description: "Detach a server from a network",
            inputSchema: {
                id: z.number(),
                network: z.number().describe("ID of the network"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, network }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/servers/${id}/actions/detach_from_network`, { body: { network } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Load Balancers ---
    server.registerTool(
        "list_load_balancers",
        {
            description: "List all load balancers",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/load_balancers", { query: p }), "load_balancers");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "get_load_balancer",
        {
            description: "Get a single load balancer by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/load_balancers/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response.load_balancer, null, 2) }] };
        })
    );

    server.registerTool(
        "create_load_balancer",
        {
            description: "Create a load balancer in a location or network_zone. Optionally attach existing Primary IPs (public_net), join a private network, and define services/targets in one call. Returns load_balancer + Action. Primary IPs on an LB cannot be changed after creation and stay assigned for its lifetime",
            inputSchema: {
                name: z.string(),
                load_balancer_type: z.string().describe("e.g. lb11 (see list_load_balancer_types)"),
                location: z.string().optional().describe("Location name, e.g. fsn1. With public_net, pass the Primary IPs' location; a mismatch fails with primary_ip_location_mismatch"),
                network_zone: z.string().optional().describe("e.g. eu-central; alternative to location"),
                algorithm: z.object({ type: z.enum(["round_robin", "least_connections"]) }).optional(),
                public_interface: z.boolean().optional().describe("Default true. false = private-only; then also pass network"),
                public_net: z
                    .object({
                        ipv4: z.number().nullable().optional().describe("ID of an unassigned IPv4 Primary IP in the same location"),
                        ipv6: z.number().nullable().optional().describe("ID of an unassigned IPv6 Primary IP in the same location"),
                    })
                    .optional()
                    .describe("Use existing Primary IPs instead of auto-allocated addresses (only with the public interface enabled)"),
                network: z.number().optional().describe("Private network ID to attach on creation"),
                services: z
                    .array(z.object({
                        protocol: z.enum(["tcp", "http", "https"]),
                        listen_port: z.number().optional(),
                        destination_port: z.number().optional(),
                        proxyprotocol: z.boolean().default(false),
                        health_check: z.record(z.unknown()).optional().describe("Same shape as add_load_balancer_service.health_check"),
                        http: z.record(z.unknown()).optional().describe("Same shape as update_load_balancer_service.http (certificates, redirect_http, sticky_sessions, timeout_idle, ...)"),
                    }))
                    .optional(),
                targets: z
                    .array(z.object({
                        type: z.enum(["server", "label_selector", "ip"]),
                        server: z.object({ id: z.number() }).optional(),
                        label_selector: z.object({ selector: z.string() }).optional(),
                        ip: z.object({ ip: z.string() }).optional(),
                        use_private_ip: z.boolean().optional(),
                    }))
                    .optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const hasLocation = args.location != null && args.location !== "";
            const hasZone = args.network_zone != null && args.network_zone !== "";
            if (!hasLocation && !hasZone) throw new Error("Provide location or network_zone");
            if (args.public_net && args.public_interface === false) {
                throw new Error("public_net requires the public interface (public_interface must not be false)");
            }
            const response = await hcloudRequest("POST", "/load_balancers", { body: args });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_load_balancer",
        {
            description: "Delete a load balancer. Returns a delete_load_balancer Action; poll get_action until it finishes",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            // Since 2026-10-05 this returns 201 + Action (previously 204 empty).
            const response = await hcloudRequest("DELETE", `/load_balancers/${id}`);
            // hcloudRequest returns {} for a 204 (the pre-2026-10-05 empty response).
            const deleted = Object.keys(response).length ? response : { deleted: true };
            return { content: [{ type: "text", text: JSON.stringify(deleted, null, 2) }] };
        })
    );

    server.registerTool(
        "update_load_balancer",
        {
            description: "Update a load balancer (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/load_balancers/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "add_load_balancer_target",
        {
            description: "Add a target to a load balancer",
            inputSchema: {
                id: z.number(),
                type: z.enum(["server", "label_selector", "ip"]),
                server: z.object({ id: z.number() }).optional(),
                label_selector: z.object({ selector: z.string() }).optional(),
                ip: z.object({ ip: z.string() }).optional(),
                use_private_ip: z.boolean().optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, type, server, label_selector, ip, use_private_ip }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/load_balancers/${id}/actions/add_target`, { body: { type, server, label_selector, ip, use_private_ip } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "remove_load_balancer_target",
        {
            description: "Remove a target from a load balancer",
            inputSchema: {
                id: z.number(),
                type: z.enum(["server", "label_selector", "ip"]),
                server: z.object({ id: z.number() }).optional(),
                label_selector: z.object({ selector: z.string() }).optional(),
                ip: z.object({ ip: z.string() }).optional(),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, type, server, label_selector, ip }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/load_balancers/${id}/actions/remove_target`, { body: { type, server, label_selector, ip } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "add_load_balancer_service",
        {
            description: "Add a service to a load balancer",
            inputSchema: {
                id: z.number(),
                protocol: z.enum(["tcp", "http", "https"]),
                listen_port: z.number(),
                destination_port: z.number(),
                proxyprotocol: z.boolean(),
                health_check: z.object({
                    protocol: z.enum(["tcp", "http"]),
                    port: z.number(),
                    interval: z.number(),
                    timeout: z.number(),
                    retries: z.number(),
                    http: z.object({
                        domain: z.string().nullable().optional(),
                        path: z.string().optional(),
                        response: z.string().optional(),
                        status_codes: z.array(z.string()).optional(),
                        tls: z.boolean().optional(),
                    }).optional(),
                }).optional(),
                http: z.object({
                    cookie_name: z.string().optional(),
                    cookie_lifetime: z.number().optional(),
                    certificates: z.array(z.number()).optional(),
                    redirect_http: z.boolean().optional(),
                    sticky_sessions: z.boolean().optional(),
                }).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async (args, _extra) => withToolError(async () => {
            const { id, ...body } = args;
            const response = await hcloudRequest("POST", `/load_balancers/${id}/actions/add_service`, { body });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_load_balancer_service",
        {
            description: "Delete a service from a load balancer",
            inputSchema: {
                id: z.number(),
                listen_port: z.number(),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, listen_port }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/load_balancers/${id}/actions/delete_service`, { body: { listen_port } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_load_balancer_service",
        {
            description: "Update a load balancer service (listen_port identifies the service)",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                listen_port: z.number().describe("Listen port of the service to update"),
                destination_port: z.number().optional(),
                protocol: z.enum(["tcp", "http", "https"]).optional(),
                proxyprotocol: z.boolean().optional(),
                health_check: z
                    .object({
                        protocol: z.enum(["tcp", "http"]),
                        port: z.number(),
                        interval: z.number(),
                        timeout: z.number(),
                        retries: z.number(),
                        http: z
                            .object({
                                domain: z.string().nullable().optional(),
                                path: z.string().optional(),
                                response: z.string().optional(),
                                status_codes: z.array(z.string()).optional(),
                                tls: z.boolean().optional(),
                            })
                            .optional(),
                    })
                    .optional(),
                http: z
                    .object({
                        cookie_name: z.string().optional(),
                        cookie_lifetime: z.number().optional(),
                        certificates: z.array(z.number()).optional(),
                        redirect_http: z.boolean().optional(),
                        sticky_sessions: z.boolean().optional(),
                        timeout_idle: z.number().int().min(30).max(300).optional().describe("Idle timeout in seconds (30-300, default 50)"),
                    })
                    .optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async (args, _extra) => withToolError(async () => {
            const { id, listen_port, ...body } = args;
            const response = await hcloudRequest("POST", `/load_balancers/${id}/actions/update_service`, { body: { listen_port, ...body } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Networks ---
    server.registerTool(
        "list_networks",
        {
            description: "List all networks",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/networks", { query: p }), "networks");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "get_network",
        {
            description: "Get a single network by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/networks/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response.network, null, 2) }] };
        })
    );

    server.registerTool(
        "create_network",
        {
            description: "Create a new network",
            inputSchema: {
                name: z.string(),
                ip_range: z.string(),
                expose_routes_to_vswitch: z.boolean().optional(),
                routes: z
                    .array(z.object({ destination: z.string(), gateway: z.string() }))
                    .optional()
                    .describe("Routes: destination (CIDR), gateway (IP)"),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                ip_range: args.ip_range,
                expose_routes_to_vswitch: args.expose_routes_to_vswitch,
                routes: args.routes,
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/networks", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_network",
        {
            description: "Delete a network",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/networks/${id}`);
            return { content: [{ type: "text", text: "Network deleted successfully" }] };
        })
    );

    server.registerTool(
        "update_network",
        {
            description: "Update a network (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/networks/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "add_network_subnet",
        {
            description: "Add a subnet to a network (e.g. for private networking 10.0.0.0/16 in a zone)",
            inputSchema: {
                id: z.number().describe("Network ID"),
                // "server" type is deprecated (removal 2027-04-15) and equivalent to "cloud".
                type: z.enum(["cloud", "vswitch"]),
                network_zone: z.string().describe("Network zone, e.g. eu-central"),
                ip_range: z.string().optional().describe("CIDR, e.g. 10.0.0.0/24; omit for auto /24"),
                vswitch_id: z.number().optional().describe("Required if type is vswitch"),
            },
            annotations: ADDITIVE,
        },
        async ({ id, type, network_zone, ip_range, vswitch_id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/networks/${id}/actions/add_subnet`, { body: { type, network_zone, ip_range, vswitch_id } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_network_subnet",
        {
            description: "Delete a subnet from a network (detach servers from it first)",
            inputSchema: {
                id: z.number().describe("Network ID"),
                ip_range: z.string().describe("IP range of subnet to delete, e.g. 10.0.1.0/24"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, ip_range }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/networks/${id}/actions/delete_subnet`, { body: { ip_range } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Volumes ---
    server.registerTool(
        "list_volumes",
        {
            description: "List all volumes",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/volumes", { query: p }), "volumes");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "get_volume",
        {
            description: "Get a single volume by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/volumes/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response.volume, null, 2) }] };
        })
    );

    server.registerTool(
        "create_volume",
        {
            description: "Create a new volume (size in GB, min 10). Give location, or server to create it in the server's location and attach it right away. In responses, read assignee ({type, id}); the old server field goes away on 2027-10-27",
            inputSchema: {
                name: z.string(),
                size: z.number().describe("Size in GB (min 10)"),
                automount: z.boolean().optional().describe("Only with server: mount automatically"),
                format: z.enum(["xfs", "ext4"]).optional(),
                location: z.string().optional().describe("Location name, e.g. fsn1 (omit if server set)"),
                server: z.number().optional().describe("Server ID to attach to on creation (omit if location set)"),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const hasLocation = args.location != null && args.location !== "";
            if (hasLocation === (args.server != null)) {
                throw new Error("Provide exactly one of location or server (mutually exclusive)");
            }
            if (args.automount && args.server == null) throw new Error("automount requires server");
            // Volume attachment is generalised to `assignee` (2026-10-27); the old
            // `server` request field is removed on 2027-10-27. Tool input stays a server ID.
            const requestBody = {
                name: args.name,
                size: args.size,
                automount: args.automount,
                format: args.format,
                location: args.location,
                ...(args.server != null ? { assignee: { type: "server", id: args.server } } : {}),
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/volumes", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_volume",
        {
            description: "Update a volume (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/volumes/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "attach_volume",
        {
            description: "Attach a volume to a server (must be in the same location). Returns an Action",
            inputSchema: {
                id: z.number(),
                server: z.number(),
                automount: z.boolean().optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, server, automount }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/volumes/${id}/actions/attach`, {
                body: { assignee: { type: "server", id: server }, automount },
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "detach_volume",
        {
            description: "Detach a volume",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/volumes/${id}/actions/detach`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_volume",
        {
            description: "Delete a volume (must be detached; all data destroyed)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/volumes/${id}`);
            return { content: [{ type: "text", text: "Volume deleted successfully" }] };
        })
    );

    // --- Firewalls ---
    server.registerTool(
        "list_firewalls",
        {
            description: "List all firewalls",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/firewalls", { query: p }), "firewalls");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "get_firewall",
        {
            description: "Get a single firewall by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/firewalls/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response.firewall, null, 2) }] };
        })
    );

    server.registerTool(
        "create_firewall",
        {
            description: "Create a new firewall. Rules: direction 'in'|'out', protocol 'tcp'|'udp'|'icmp'|'esp'|'gre'; use source_ips for in, destination_ips for out (CIDRs, e.g. 0.0.0.0/0); port optional for tcp/udp. Optionally apply_to servers or label_selector at creation.",
            inputSchema: {
                name: z.string(),
                rules: z.array(firewallRuleSchema).optional(),
                apply_to: z.array(firewallApplyToSchema).optional().describe("Apply firewall to these servers or label_selector after creation"),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const body = {
                name: args.name,
                rules: args.rules,
                labels: args.labels,
                apply_to: args.apply_to,
            };
            const response = await hcloudRequest("POST", "/firewalls", { body });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_firewall",
        {
            description: "Update a firewall (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/firewalls/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_firewall",
        {
            description: "Delete a firewall (must not be in use)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/firewalls/${id}`);
            return { content: [{ type: "text", text: "Firewall deleted successfully" }] };
        })
    );

    server.registerTool(
        "apply_firewall_to_resources",
        {
            description: "Apply a firewall to servers or a label selector. Pass apply_to: [{ type: 'server', server: { id: 123 } }] or [{ type: 'label_selector', label_selector: { selector: 'env=web' } }].",
            inputSchema: {
                id: z.number().describe("Firewall ID"),
                apply_to: z.array(firewallApplyToSchema),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, apply_to }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/firewalls/${id}/actions/apply_to_resources`, { body: { apply_to } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "remove_firewall_from_resources",
        {
            description: "Remove a firewall from servers. Pass remove_from: [{ type: 'server', server: { id: 123 } }].",
            inputSchema: {
                id: z.number().describe("Firewall ID"),
                remove_from: z.array(z.object({
                    type: z.literal("server"),
                    server: z.object({ id: z.number() }),
                })),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, remove_from }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/firewalls/${id}/actions/remove_from_resources`, { body: { remove_from } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "set_firewall_rules",
        {
            description: "Set rules on an existing firewall (overwrites all rules). Same rule format as create_firewall.",
            inputSchema: {
                id: z.number().describe("Firewall ID"),
                rules: z.array(firewallRuleSchema),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, rules }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/firewalls/${id}/actions/set_rules`, { body: { rules } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Floating IPs ---
    server.registerTool(
        "list_floating_ips",
        {
            description: "List all floating IPs",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/floating_ips", { query: p }), "floating_ips");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "create_floating_ip",
        {
            description: "Create a floating IP",
            inputSchema: {
                type: z.enum(["ipv4", "ipv6"]),
                home_location: z.string().optional(),
                server: z.number().optional(),
                description: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                type: args.type,
                home_location: args.home_location,
                server: args.server,
                description: args.description,
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/floating_ips", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_floating_ip",
        {
            description: "Update a floating IP (description, labels)",
            inputSchema: {
                id: z.number(),
                description: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, description, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/floating_ips/${id}`, { body: { description, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "assign_floating_ip",
        {
            description: "Assign a floating IP to a server",
            inputSchema: {
                id: z.number(),
                server: z.number(),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, server }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/floating_ips/${id}/actions/assign`, { body: { server } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "unassign_floating_ip",
        {
            description: "Unassign a floating IP",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/floating_ips/${id}/actions/unassign`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_floating_ip",
        {
            description: "Delete a floating IP. Must be unassigned first (unassign_floating_ip), else fails with must_be_unassigned",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/floating_ips/${id}`);
            return { content: [{ type: "text", text: "Floating IP deleted successfully" }] };
        })
    );

    // --- Primary IPs ---
    server.registerTool(
        "list_primary_ips",
        {
            description: "List all Primary IPs (static IPs bound to a location, assignable to one server)",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/primary_ips", { query: p }), "primary_ips");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "create_primary_ip",
        {
            description: "Create a Primary IP (location-scoped; server must be off to assign). Provide location OR assignee_id (server).",
            inputSchema: {
                name: z.string(),
                type: z.enum(["ipv4", "ipv6"]),
                location: z.string().optional().describe("Location name or ID, e.g. fsn1 (omit if assignee_id set)"),
                assignee_id: z.number().optional().describe("Server ID to assign to immediately (omit if location set)"),
                auto_delete: z.boolean().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const hasLocation = args.location != null && args.location !== "";
            const hasAssignee = args.assignee_id != null;
            if (hasLocation === hasAssignee) {
                throw new Error("Provide exactly one of location or assignee_id (mutually exclusive)");
            }
            // The API takes `location` (the `datacenter` field was removed 2026-07-01).
            const requestBody = {
                name: args.name,
                type: args.type,
                location: args.location,
                assignee_id: args.assignee_id,
                ...(hasAssignee ? { assignee_type: "server" as const } : {}),
                auto_delete: args.auto_delete,
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/primary_ips", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "get_primary_ip",
        {
            description: "Get a single Primary IP by ID",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/primary_ips/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_primary_ip",
        {
            description: "Update a Primary IP (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/primary_ips/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_primary_ip",
        {
            description: "Delete a Primary IP. Must be unassigned first (unassign_primary_ip, server powered off), else fails with must_be_unassigned",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/primary_ips/${id}`);
            return { content: [{ type: "text", text: "Primary IP deleted successfully" }] };
        })
    );

    server.registerTool(
        "assign_primary_ip",
        {
            description: "Assign a Primary IP to a server (server must be powered off)",
            inputSchema: {
                id: z.number().describe("Primary IP ID"),
                server: z.number().describe("Server ID"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, server }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/primary_ips/${id}/actions/assign`, { body: { assignee_id: server, assignee_type: "server" } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "unassign_primary_ip",
        {
            description: "Unassign a Primary IP from its server (server must be powered off)",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/primary_ips/${id}/actions/unassign`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- SSH Keys ---
    server.registerTool(
        "list_ssh_keys",
        {
            description: "List all SSH keys",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/ssh_keys", { query: p }), "ssh_keys");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "create_ssh_key",
        {
            description: "Create a new SSH key (public_key is trimmed; the API rejects leading whitespace)",
            inputSchema: {
                name: z.string(),
                public_key: z.string(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                // API rejects leading whitespace since 2026-04-22; pasted keys often carry it.
                public_key: args.public_key.trim(),
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/ssh_keys", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "update_ssh_key",
        {
            description: "Update an SSH key (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/ssh_keys/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_ssh_key",
        {
            description: "Delete an SSH key",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/ssh_keys/${id}`);
            return { content: [{ type: "text", text: "SSH key deleted successfully" }] };
        })
    );

    // --- General Info ---
    server.registerTool(
        "list_locations",
        {
            description: "List all locations",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/locations", { query: p }), "locations");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "list_images",
        {
            description: "List all images (check each image's `deprecation` field; deprecated images can stop being usable for new servers)",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/images", { query: p }), "images");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "list_server_types",
        {
            description: "List all server types. Per-location availability is in locations[]: available, recommended, deprecation (top-level `deprecated` was removed)",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/server_types", { query: p }), "server_types");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "list_load_balancer_types",
        {
            description: "List all load balancer types (for create_load_balancer load_balancer_type; check `deprecation`)",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/load_balancer_types", { query: p }), "load_balancer_types");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "list_actions",
        {
            description: "Get an action by ID with optional status filter. Hetzner no longer supports listing all actions in a project, so id is required. Prefer get_action",
            inputSchema: {
                id: z.number().describe("Action ID (required by the API since 2025-01-30)"),
                status: z.enum(["running", "success", "error"]).optional(),
                sort: z
                    .enum([
                        "id", "id:asc", "id:desc", "command", "command:asc", "command:desc",
                        "status", "status:asc", "status:desc", "started", "started:asc", "started:desc",
                        "finished", "finished:asc", "finished:desc",
                    ])
                    .optional(),
                page: z.number().optional(),
                per_page: z.number().optional(),
            },
            annotations: READ_ONLY,
        },
        async (args, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", "/actions", { query: { id: args.id, status: args.status, sort: args.sort, page: args.page, per_page: args.per_page } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "get_action",
        {
            description: "Get a single action by ID (e.g. to check progress or status after create/delete)",
            inputSchema: { id: z.number() },
            annotations: READ_ONLY,
        },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("GET", `/actions/${id}`);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "get_pricing",
        {
            description: "Get all prices",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const response = await hcloudRequest("GET", "/pricing");
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Placement Groups ---
    server.registerTool(
        "list_placement_groups",
        {
            description: "List all placement groups",
            inputSchema: {},
            annotations: READ_ONLY,
        },
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => hcloudRequest("GET", "/placement_groups", { query: p }), "placement_groups");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        "create_placement_group",
        {
            description: "Create a new placement group",
            inputSchema: {
                name: z.string(),
                type: z.enum(["spread"]),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE,
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                type: args.type,
                labels: args.labels,
            };
            const response = await hcloudRequest("POST", "/placement_groups", { body: requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.registerTool(
        "delete_placement_group",
        {
            description: "Delete a placement group",
            inputSchema: { id: z.number() },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }, _extra) => withToolError(async () => {
            await hcloudRequest("DELETE", `/placement_groups/${id}`);
            return { content: [{ type: "text", text: "Placement Group deleted successfully" }] };
        })
    );

    server.registerTool(
        "update_placement_group",
        {
            description: "Update a placement group (name, labels)",
            inputSchema: {
                id: z.number(),
                name: z.string().optional(),
                labels: z.record(z.string()).optional(),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("PUT", `/placement_groups/${id}`, { body: { name, labels } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );
}
