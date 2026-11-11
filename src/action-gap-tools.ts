// Remaining server / load balancer / network actions and ISO listing (issue #20).
// Action tools return the API response ({ action }); poll get_action until status is success.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest } from "./hcloud-api.js";
import { ADDITIVE_IDEMPOTENT, DESTRUCTIVE_IDEMPOTENT, READ_ONLY, json, listAll, withToolError } from "./tool-helpers.js";

const action = (path: string, body?: unknown) =>
    withToolError(async () => json(await hcloudRequest("POST", path, { body: body ?? {} })));

export function registerActionGapTools(server: McpServer) {
    // --- Servers ---
    server.registerTool(
        "add_server_to_placement_group",
        {
            description: "Add a server to a placement group. The server must be powered off (422 server_not_stopped) and not already in a placement group (422 already_in_placement_group). Returns an Action",
            inputSchema: {
                id: z.number().describe("Server ID"),
                placement_group: z.number().describe("Placement group ID"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, placement_group }) => action(`/servers/${id}/actions/add_to_placement_group`, { placement_group }),
    );

    server.registerTool(
        "remove_server_from_placement_group",
        {
            description: "Remove a server from its placement group. Returns an Action",
            inputSchema: { id: z.number().describe("Server ID") },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }) => action(`/servers/${id}/actions/remove_from_placement_group`),
    );

    server.registerTool(
        "change_server_alias_ips",
        {
            description: "Set the alias IPs of a server on a network it is already attached to. REPLACES the existing alias list for that network: to add one, pass the current alias_ips (get_server private_net) plus the new IP; pass [] to remove all. Returns an Action",
            inputSchema: {
                id: z.number().describe("Server ID"),
                network: z.number().describe("ID of a network already attached to the server"),
                alias_ips: z.array(z.string()).describe("Complete new list of alias IPs, e.g. [\"10.0.1.50\"]"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, network, alias_ips }) => action(`/servers/${id}/actions/change_alias_ips`, { network, alias_ips }),
    );

    // --- Load balancers ---
    server.registerTool(
        "attach_load_balancer_to_network",
        {
            description: "Attach a load balancer to a network (one network per load balancer). Optionally request a specific private ip, or ip_range to auto-assign from a specific subnet; ip must lie within ip_range if both are given. Returns an Action",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                network: z.number().describe("Network ID"),
                ip: z.string().optional().describe("Private IP to assign; auto-assigned if omitted"),
                ip_range: z.string().optional().describe("Subnet ip_range (CIDR) to auto-assign the IP from, e.g. 10.0.1.0/24"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, network, ip, ip_range }) => action(`/load_balancers/${id}/actions/attach_to_network`, { network, ip, ip_range }),
    );

    server.registerTool(
        "detach_load_balancer_from_network",
        {
            description: "Detach a load balancer from a network. Re-enable the public interface first if it was disabled, or the load balancer becomes unreachable. Returns an Action",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                network: z.number().describe("Network ID"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, network }) => action(`/load_balancers/${id}/actions/detach_from_network`, { network }),
    );

    server.registerTool(
        "change_load_balancer_algorithm",
        {
            description: "Change how a load balancer distributes new requests across targets. Returns an Action",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                type: z.enum(["round_robin", "least_connections"]),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, type }) => action(`/load_balancers/${id}/actions/change_algorithm`, { type }),
    );

    server.registerTool(
        "change_load_balancer_type",
        {
            description: "Change a load balancer's type (max services / targets / connections; price changes accordingly — check get_pricing). Fails with invalid_load_balancer_type if the current config exceeds the new type's limits. Returns an Action",
            inputSchema: {
                id: z.number().describe("Load balancer ID"),
                load_balancer_type: z.string().describe("Type name or ID, e.g. lb11, lb21, lb31"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, load_balancer_type }) => action(`/load_balancers/${id}/actions/change_type`, { load_balancer_type }),
    );

    server.registerTool(
        "enable_load_balancer_public_interface",
        {
            description: "Enable a load balancer's public interface so it is reachable from the internet via its public IPs. Returns an Action",
            inputSchema: { id: z.number().describe("Load balancer ID") },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id }) => action(`/load_balancers/${id}/actions/enable_public_interface`),
    );

    server.registerTool(
        "disable_load_balancer_public_interface",
        {
            description: "Disable a load balancer's public interface (private-network only). Requires the load balancer to be attached to a network (load_balancer_not_attached_to_network) and all targets to use_private_ip (targets_without_use_private_ip). Returns an Action",
            inputSchema: { id: z.number().describe("Load balancer ID") },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id }) => action(`/load_balancers/${id}/actions/disable_public_interface`),
    );

    // --- Networks ---
    server.registerTool(
        "add_network_route",
        {
            description: "Add a route to a network: traffic for destination is sent to gateway. destination must be an RFC1918 range or 0.0.0.0/0 and must not overlap subnets or other routes; gateway must be an IP inside the network (not its first IP, not 172.31.1.1). Returns an Action",
            inputSchema: {
                id: z.number().describe("Network ID"),
                destination: z.string().describe("Destination CIDR, e.g. 10.100.1.0/24 or 0.0.0.0/0"),
                gateway: z.string().describe("Gateway IP inside the network, e.g. a server's private IP 10.0.1.2"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, destination, gateway }) => action(`/networks/${id}/actions/add_route`, { destination, gateway }),
    );

    server.registerTool(
        "delete_network_route",
        {
            description: "Delete a route from a network. destination and gateway must match the existing route exactly (see get_network routes). Returns an Action",
            inputSchema: {
                id: z.number().describe("Network ID"),
                destination: z.string().describe("Destination CIDR of the route"),
                gateway: z.string().describe("Gateway IP of the route"),
            },
            annotations: DESTRUCTIVE_IDEMPOTENT,
        },
        async ({ id, destination, gateway }) => action(`/networks/${id}/actions/delete_route`, { destination, gateway }),
    );

    server.registerTool(
        "change_network_ip_range",
        {
            description: "Change a network's IP range. Can only be extended by shortening the netmask with the same base address (10.0.0.0/16 -> 10.0.0.0/15), never shrunk. The network must have NO attached servers or load balancers (detach them first). Returns an Action",
            inputSchema: {
                id: z.number().describe("Network ID"),
                ip_range: z.string().describe("New range in CIDR, same start IP as the current range, e.g. 10.0.0.0/15"),
            },
            annotations: ADDITIVE_IDEMPOTENT,
        },
        async ({ id, ip_range }) => action(`/networks/${id}/actions/change_ip_range`, { ip_range }),
    );

    // --- ISOs ---
    server.registerTool(
        "list_isos",
        {
            description: "List ISOs available to attach_iso (public and private). name is an exact match. architecture filters x86/arm; include_architecture_wildcard (requires architecture) also includes ISOs with no architecture. Check deprecation before use. All pages",
            inputSchema: {
                name: z.string().optional().describe("Exact ISO name"),
                architecture: z.enum(["x86", "arm"]).optional(),
                include_architecture_wildcard: z.boolean().optional()
                    .describe("Also include ISOs with architecture null; only valid together with architecture"),
            },
            annotations: READ_ONLY,
        },
        async (filters) => withToolError(async () => {
            if (filters.include_architecture_wildcard !== undefined && !filters.architecture) {
                throw new Error("include_architecture_wildcard requires architecture");
            }
            const isos = await listAll(
                (p) => hcloudRequest("GET", "/isos", { query: { ...filters, ...p } }),
                "isos",
            );
            return json(isos);
        }),
    );
}
