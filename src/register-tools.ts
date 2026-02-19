
import { McpServer } from "./mcp-server.js";
import {
    ServersService,
    LoadBalancersService,
    NetworksService,
    VolumesService,
    FirewallsService,
    FloatingIPsService,
    SshKeysService,
    ImagesService,
    LocationsService,
    ServerTypesService,
    PlacementGroupsService,
    CertificatesService,
    PrimaryIPsService,
    ServerActionsService,
    VolumeActionsService,
    FloatingIpActionsService,
    LoadBalancerActionsService,
    NetworkActionsService,
    PricingService,
    ActionsService,
    LoadBalancerTypesService,
    DatacentersService,
    PrimaryIpActionsService,
} from "hetzner-sdk-ts";
import { z } from "zod";

const formatError = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};

type ToolResult = {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    isError?: boolean;
};

async function withToolError(run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run();
    } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
    }
}

export function registerTools(server: McpServer) {
    // --- Servers ---
    server.tool(
        "list_servers",
        "List all servers",
        {},
        async () => withToolError(async () => {
            const response = await ServersService.getServers({});
            return { content: [{ type: "text", text: JSON.stringify(response.servers, null, 2) }] };
        })
    );

    server.tool(
        "create_server",
        "Create a new server",
        {
            name: z.string(),
            server_type: z.string(),
            image: z.string(),
            location: z.string().optional(),
            start_after_create: z.boolean().optional(),
            ssh_keys: z.array(z.union([z.string(), z.number()])).optional().describe("List of SSH key names or IDs"),
            firewalls: z.array(z.object({ firewall: z.number() })).optional(),
            networks: z.array(z.number()).optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await ServersService.postServers({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_server",
        "Delete a server",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServersService.deleteServers({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "change_server_type",
        "Change the type of a server (scales resources). Server must be powered off.",
        {
            id: z.number(),
            server_type: z.string().describe("New server type (e.g. cx22)"),
            upgrade_disk: z.boolean().default(true).describe("Whether to upgrade disk size. If true, cannot downgrade later."),
        },
        async ({ id, server_type, upgrade_disk }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsChangeType({
                id,
                requestBody: { server_type, upgrade_disk }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "power_on_server",
        "Power on a server",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsPoweron({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "power_off_server",
        "Power off a server (hard)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsPoweroff({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "reboot_server",
        "Reboot a server (soft)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsReboot({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "shutdown_server",
        "Shutdown a server (soft)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsShutdown({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "reset_server",
        "Reset a server (hard)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsReset({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_server",
        "Update a server (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await ServersService.putServers({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "attach_iso",
        "Attach an ISO to a server",
        {
            id: z.number(),
            iso: z.string().describe("ID or name of the ISO"),
        },
        async ({ id, iso }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsAttachIso({
                id,
                requestBody: { iso }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "detach_iso",
        "Detach an ISO from a server",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsDetachIso({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "attach_server_to_network",
        "Attach a server to a network",
        {
            id: z.number(),
            network: z.number().describe("ID of the network"),
            ip: z.string().optional().describe("IP to request, otherwise auto-assigned"),
            alias_ips: z.array(z.string()).optional(),
        },
        async ({ id, network, ip, alias_ips }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsAttachToNetwork({
                id,
                requestBody: { network, ip, alias_ips }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "detach_server_from_network",
        "Detach a server from a network",
        {
            id: z.number(),
            network: z.number().describe("ID of the network"),
        },
        async ({ id, network }) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsDetachFromNetwork({
                id,
                requestBody: { network }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Load Balancers ---
    server.tool(
        "list_load_balancers",
        "List all load balancers",
        {},
        async () => withToolError(async () => {
            const response = await LoadBalancersService.getLoadBalancers({});
            return { content: [{ type: "text", text: JSON.stringify(response.load_balancers, null, 2) }] };
        })
    );

    server.tool(
        "create_load_balancer",
        "Create a new load balancer",
        {
            name: z.string(),
            algorithm: z.object({ type: z.enum(["round_robin", "least_connections"]) }).optional(),
            location: z.string(),
            load_balancer_type: z.string(),
            network_zone: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await LoadBalancersService.postLoadBalancers({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_load_balancer",
        "Delete a load balancer",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await LoadBalancersService.deleteLoadBalancers({ id });
            return { content: [{ type: "text", text: "Load Balancer deleted successfully" }] };
        })
    );

    server.tool(
        "update_load_balancer",
        "Update a load balancer (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await LoadBalancersService.putLoadBalancers({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "add_load_balancer_target",
        "Add a target to a load balancer",
        {
            id: z.number(),
            type: z.enum(["server", "label_selector", "ip"]),
            server: z.object({ id: z.number() }).optional(),
            label_selector: z.object({ selector: z.string() }).optional(),
            ip: z.object({ ip: z.string() }).optional(),
            use_private_ip: z.boolean().optional(),
        },
        async ({ id, type, server, label_selector, ip, use_private_ip }) => withToolError(async () => {
            const response = await LoadBalancerActionsService.postLoadBalancersActionsAddTarget({
                id,
                requestBody: { type, server, label_selector, ip, use_private_ip }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "remove_load_balancer_target",
        "Remove a target from a load balancer",
        {
            id: z.number(),
            type: z.enum(["server", "label_selector", "ip"]),
            server: z.object({ id: z.number() }).optional(),
            label_selector: z.object({ selector: z.string() }).optional(),
            ip: z.object({ ip: z.string() }).optional(),
        },
        async ({ id, type, server, label_selector, ip }) => withToolError(async () => {
            const response = await LoadBalancerActionsService.postLoadBalancersActionsRemoveTarget({
                id,
                requestBody: { type, server, label_selector, ip }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "add_load_balancer_service",
        "Add a service to a load balancer",
        {
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
        async (args) => withToolError(async () => {
            const response = await LoadBalancerActionsService.postLoadBalancersActionsAddService({
                id: args.id,
                requestBody: args as any
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_load_balancer_service",
        "Delete a service from a load balancer",
        {
            id: z.number(),
            listen_port: z.number(),
        },
        async ({ id, listen_port }) => withToolError(async () => {
            const response = await LoadBalancerActionsService.postLoadBalancersActionsDeleteService({
                id,
                requestBody: { listen_port }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Networks ---
    server.tool(
        "list_networks",
        "List all networks",
        {},
        async () => withToolError(async () => {
            const response = await NetworksService.getNetworks({});
            return { content: [{ type: "text", text: JSON.stringify(response.networks, null, 2) }] };
        })
    );

    server.tool(
        "create_network",
        "Create a new network",
        {
            name: z.string(),
            ip_range: z.string(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await NetworksService.postNetworks({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_network",
        "Delete a network",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await NetworksService.deleteNetworks({ id });
            return { content: [{ type: "text", text: "Network deleted successfully" }] };
        })
    );

    server.tool(
        "update_network",
        "Update a network (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await NetworksService.putNetworks({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "add_network_subnet",
        "Add a subnet to a network (e.g. for private networking 10.0.0.0/16 in a zone)",
        {
            id: z.number().describe("Network ID"),
            type: z.enum(["cloud", "server", "vswitch"]),
            network_zone: z.string().describe("Network zone, e.g. eu-central"),
            ip_range: z.string().optional().describe("CIDR, e.g. 10.0.0.0/24; omit for auto /24"),
            vswitch_id: z.number().optional().describe("Required if type is vswitch"),
        },
        async ({ id, type, network_zone, ip_range, vswitch_id }) => withToolError(async () => {
            const response = await NetworkActionsService.postNetworksActionsAddSubnet({
                id,
                requestBody: { type, network_zone, ip_range, vswitch_id }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_network_subnet",
        "Delete a subnet from a network (detach servers from it first)",
        {
            id: z.number().describe("Network ID"),
            ip_range: z.string().describe("IP range of subnet to delete, e.g. 10.0.1.0/24"),
        },
        async ({ id, ip_range }) => withToolError(async () => {
            const response = await NetworkActionsService.postNetworksActionsDeleteSubnet({
                id,
                requestBody: { ip_range }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Volumes ---
    server.tool(
        "list_volumes",
        "List all volumes",
        {},
        async () => withToolError(async () => {
            const response = await VolumesService.getVolumes({});
            return { content: [{ type: "text", text: JSON.stringify(response.volumes, null, 2) }] };
        })
    );

    server.tool(
        "create_volume",
        "Create a new volume",
        {
            name: z.string(),
            size: z.number(),
            automount: z.boolean().optional(),
            format: z.string().optional(),
            location: z.string().optional(),
            server: z.number().optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await VolumesService.postVolumes({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_volume",
        "Update a volume (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await VolumesService.putVolumes({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "attach_volume",
        "Attach a volume to a server",
        {
            id: z.number(),
            server: z.number(),
            automount: z.boolean().optional(),
        },
        async ({ id, server, automount }) => withToolError(async () => {
            const response = await VolumeActionsService.postVolumesActionsAttach({
                id,
                requestBody: { server, automount }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "detach_volume",
        "Detach a volume",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await VolumeActionsService.postVolumesActionsDetach({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_volume",
        "Delete a volume (must be detached; all data destroyed)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await VolumesService.deleteVolumes({ id });
            return { content: [{ type: "text", text: "Volume deleted successfully" }] };
        })
    );

    // --- Firewalls ---
    server.tool(
        "list_firewalls",
        "List all firewalls",
        {},
        async () => withToolError(async () => {
            const response = await FirewallsService.getFirewalls({});
            return { content: [{ type: "text", text: JSON.stringify(response.firewalls, null, 2) }] };
        })
    );

    server.tool(
        "create_firewall",
        "Create a new firewall",
        {
            name: z.string(),
            rules: z.array(z.any()).optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await FirewallsService.postFirewalls({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_firewall",
        "Update a firewall (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await FirewallsService.putFirewalls({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_firewall",
        "Delete a firewall (must not be in use)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await FirewallsService.deleteFirewalls({ id });
            return { content: [{ type: "text", text: "Firewall deleted successfully" }] };
        })
    );

    // --- Floating IPs ---
    server.tool(
        "list_floating_ips",
        "List all floating IPs",
        {},
        async () => withToolError(async () => {
            const response = await FloatingIPsService.getFloatingIps({});
            return { content: [{ type: "text", text: JSON.stringify(response.floating_ips, null, 2) }] };
        })
    );

    server.tool(
        "create_floating_ip",
        "Create a floating IP",
        {
            type: z.enum(["ipv4", "ipv6"]),
            home_location: z.string().optional(),
            server: z.number().optional(),
            description: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await FloatingIPsService.postFloatingIps({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_floating_ip",
        "Update a floating IP (description, labels)",
        {
            id: z.number(),
            description: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, description, labels }) => withToolError(async () => {
            const response = await FloatingIPsService.putFloatingIps({
                id,
                requestBody: { description, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "assign_floating_ip",
        "Assign a floating IP to a server",
        {
            id: z.number(),
            server: z.number(),
        },
        async ({ id, server }) => withToolError(async () => {
            const response = await FloatingIpActionsService.postFloatingIpsActionsAssign({
                id,
                requestBody: { server }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "unassign_floating_ip",
        "Unassign a floating IP",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await FloatingIpActionsService.postFloatingIpsActionsUnassign({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_floating_ip",
        "Delete a floating IP (unassigns from server if attached)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await FloatingIPsService.deleteFloatingIps({ id });
            return { content: [{ type: "text", text: "Floating IP deleted successfully" }] };
        })
    );

    // --- Primary IPs ---
    server.tool(
        "list_primary_ips",
        "List all Primary IPs (static IPs bound to a datacenter, assignable to one server)",
        {},
        async () => withToolError(async () => {
            const response = await PrimaryIPsService.getPrimaryIps({});
            return { content: [{ type: "text", text: JSON.stringify(response.primary_ips, null, 2) }] };
        })
    );

    server.tool(
        "create_primary_ip",
        "Create a Primary IP (datacenter-scoped; server must be off to assign). Provide datacenter OR assignee_id (server).",
        {
            name: z.string(),
            type: z.enum(["ipv4", "ipv6"]),
            datacenter: z.string().optional().describe("ID or name of datacenter (omit if assignee_id set)"),
            assignee_id: z.number().optional().describe("Server ID to assign to immediately (omit if datacenter set)"),
            auto_delete: z.boolean().optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                type: args.type,
                assignee_type: "server" as const,
                datacenter: args.datacenter,
                assignee_id: args.assignee_id,
                auto_delete: args.auto_delete,
                labels: args.labels,
            };
            const response = await PrimaryIPsService.postPrimaryIps({ requestBody: requestBody as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_primary_ip",
        "Get a single Primary IP by ID",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await PrimaryIPsService.getPrimaryIps1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_primary_ip",
        "Update a Primary IP (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await PrimaryIPsService.putPrimaryIps({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_primary_ip",
        "Delete a Primary IP (unassigns from server if assigned; server must be off)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await PrimaryIPsService.deletePrimaryIps({ id });
            return { content: [{ type: "text", text: "Primary IP deleted successfully" }] };
        })
    );

    server.tool(
        "assign_primary_ip",
        "Assign a Primary IP to a server (server must be powered off)",
        {
            id: z.number().describe("Primary IP ID"),
            server: z.number().describe("Server ID"),
        },
        async ({ id, server }) => withToolError(async () => {
            const response = await PrimaryIpActionsService.postPrimaryIpsActionsAssign({
                id,
                requestBody: { assignee_id: server, assignee_type: "server" }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "unassign_primary_ip",
        "Unassign a Primary IP from its server (server must be powered off)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await PrimaryIpActionsService.postPrimaryIpsActionsUnassign({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- SSH Keys ---
    server.tool(
        "list_ssh_keys",
        "List all SSH keys",
        {},
        async () => withToolError(async () => {
            const response = await SshKeysService.getSshKeys({});
            return { content: [{ type: "text", text: JSON.stringify(response.ssh_keys, null, 2) }] };
        })
    );

    server.tool(
        "create_ssh_key",
        "Create a new SSH key",
        {
            name: z.string(),
            public_key: z.string(),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await SshKeysService.postSshKeys({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_ssh_key",
        "Update an SSH key (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await SshKeysService.putSshKeys({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_ssh_key",
        "Delete an SSH key",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await SshKeysService.deleteSshKeys({ id });
            return { content: [{ type: "text", text: "SSH key deleted successfully" }] };
        })
    );

    // --- General Info ---
    server.tool(
        "list_locations",
        "List all locations",
        {},
        async () => withToolError(async () => {
            const response = await LocationsService.getLocations({});
            return { content: [{ type: "text", text: JSON.stringify(response.locations, null, 2) }] };
        })
    );

    server.tool(
        "list_images",
        "List all images",
        {},
        async () => withToolError(async () => {
            const response = await ImagesService.getImages({});
            return { content: [{ type: "text", text: JSON.stringify(response.images, null, 2) }] };
        })
    );

    server.tool(
        "list_server_types",
        "List all server types",
        {},
        async () => withToolError(async () => {
            const response = await ServerTypesService.getServerTypes({});
            return { content: [{ type: "text", text: JSON.stringify(response.server_types, null, 2) }] };
        })
    );

    server.tool(
        "list_load_balancer_types",
        "List all load balancer types (for create_load_balancer load_balancer_type)",
        {},
        async () => withToolError(async () => {
            const response = await LoadBalancerTypesService.getLoadBalancerTypes({});
            return { content: [{ type: "text", text: JSON.stringify(response.load_balancer_types, null, 2) }] };
        })
    );

    server.tool(
        "list_datacenters",
        "List all datacenters (e.g. ash-dc1; where servers can be created)",
        {},
        async () => withToolError(async () => {
            const response = await DatacentersService.getDatacenters({});
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "list_actions",
        "List actions (optionally filter by id, status); use to poll/wait for create/delete results",
        {
            id: z.number().optional(),
            status: z.enum(["running", "success", "error"]).optional(),
            sort: z.string().optional(),
            page: z.number().optional(),
            per_page: z.number().optional(),
        },
        async (args) => withToolError(async () => {
            const response = await ActionsService.getActions(args as any);
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_action",
        "Get a single action by ID (e.g. to check progress or status after create/delete)",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            const response = await ActionsService.getActions1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_pricing",
        "Get all prices",
        {},
        async () => withToolError(async () => {
            const response = await PricingService.getPricing();
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Placement Groups ---
    server.tool(
        "list_placement_groups",
        "List all placement groups",
        {},
        async () => withToolError(async () => {
            const response = await PlacementGroupsService.getPlacementGroups({});
            return { content: [{ type: "text", text: JSON.stringify(response.placement_groups, null, 2) }] };
        })
    );

    server.tool(
        "create_placement_group",
        "Create a new placement group",
        {
            name: z.string(),
            type: z.enum(["spread"]),
            labels: z.record(z.string()).optional(),
        },
        async (args) => withToolError(async () => {
            const response = await PlacementGroupsService.postPlacementGroups({ requestBody: args as any });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_placement_group",
        "Delete a placement group",
        { id: z.number() },
        async ({ id }) => withToolError(async () => {
            await PlacementGroupsService.deletePlacementGroups({ id });
            return { content: [{ type: "text", text: "Placement Group deleted successfully" }] };
        })
    );

    server.tool(
        "update_placement_group",
        "Update a placement group (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }) => withToolError(async () => {
            const response = await PlacementGroupsService.putPlacementGroups({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );
}
