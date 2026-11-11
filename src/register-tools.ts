
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    ServersService,
    LoadBalancersService,
    NetworksService,
    VolumesService,
    FirewallsService,
    FirewallActionsService,
    FloatingIPsService,
    SshKeysService,
    ImagesService,
    LocationsService,
    ServerTypesService,
    PlacementGroupsService,
    PrimaryIPsService,
    ServerActionsService,
    VolumeActionsService,
    FloatingIpActionsService,
    LoadBalancerActionsService,
    NetworkActionsService,
    PricingService,
    ActionsService,
    LoadBalancerTypesService,
    PrimaryIpActionsService,
} from "hetzner-sdk-ts";
import { z } from "zod";
import { listAll, withToolError } from "./tool-helpers.js";
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
    server.tool(
        "list_servers",
        "List all servers",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => ServersService.getServers(p), "servers");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "get_server",
        "Get a single server by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ServersService.getServers1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response.server, null, 2) }] };
        })
    );

    server.tool(
        "create_server",
        "Create a new server",
        {
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
            const response = await ServersService.postServers({ requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_server",
        "Delete a server",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, server_type, upgrade_disk }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsPoweron({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "power_off_server",
        "Power off a server (hard)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsPoweroff({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "reboot_server",
        "Reboot a server (soft)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsReboot({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "shutdown_server",
        "Shutdown a server (soft)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ServerActionsService.postServersActionsShutdown({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "reset_server",
        "Reset a server (hard)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
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
        async ({ id, iso }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, network, ip, alias_ips }, _extra) => withToolError(async () => {
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
        async ({ id, network }, _extra) => withToolError(async () => {
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
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => LoadBalancersService.getLoadBalancers(p), "load_balancers");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "get_load_balancer",
        "Get a single load balancer by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await LoadBalancersService.getLoadBalancers1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response.load_balancer, null, 2) }] };
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
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                load_balancer_type: args.load_balancer_type,
                location: args.location,
                algorithm: args.algorithm,
                network_zone: args.network_zone,
                labels: args.labels,
            };
            const response = await LoadBalancersService.postLoadBalancers({ requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_load_balancer",
        "Delete a load balancer. Returns a delete_load_balancer Action; poll get_action until it finishes",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            // Since 2026-10-05 this returns 201 + Action (previously 204 empty).
            const response = await LoadBalancersService.deleteLoadBalancers({ id });
            return { content: [{ type: "text", text: JSON.stringify(response ?? { deleted: true }, null, 2) }] };
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
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
        async ({ id, type, server, label_selector, ip, use_private_ip }, _extra) => withToolError(async () => {
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
        async ({ id, type, server, label_selector, ip }, _extra) => withToolError(async () => {
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
        async (args, _extra) => withToolError(async () => {
            const { id, ...body } = args;
            const response = await LoadBalancerActionsService.postLoadBalancersActionsAddService({
                id,
                requestBody: body as Parameters<typeof LoadBalancerActionsService.postLoadBalancersActionsAddService>[0]["requestBody"]
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
        async ({ id, listen_port }, _extra) => withToolError(async () => {
            const response = await LoadBalancerActionsService.postLoadBalancersActionsDeleteService({
                id,
                requestBody: { listen_port }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "update_load_balancer_service",
        "Update a load balancer service (listen_port identifies the service)",
        {
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
        async (args, _extra) => withToolError(async () => {
            const { id, listen_port, ...body } = args;
            const response = await LoadBalancerActionsService.postLoadBalancersActionsUpdateService({
                id,
                requestBody: { listen_port, ...body }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Networks ---
    server.tool(
        "list_networks",
        "List all networks",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => NetworksService.getNetworks(p), "networks");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "get_network",
        "Get a single network by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await NetworksService.getNetworks1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response.network, null, 2) }] };
        })
    );

    server.tool(
        "create_network",
        "Create a new network",
        {
            name: z.string(),
            ip_range: z.string(),
            expose_routes_to_vswitch: z.boolean().optional(),
            routes: z
                .array(z.object({ destination: z.string(), gateway: z.string() }))
                .optional()
                .describe("Routes: destination (CIDR), gateway (IP)"),
            labels: z.record(z.string()).optional(),
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                ip_range: args.ip_range,
                expose_routes_to_vswitch: args.expose_routes_to_vswitch,
                routes: args.routes,
                labels: args.labels,
            };
            const response = await NetworksService.postNetworks({ requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_network",
        "Delete a network",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
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
            // "server" type is deprecated (removal 2027-04-15) and equivalent to "cloud".
            type: z.enum(["cloud", "vswitch"]),
            network_zone: z.string().describe("Network zone, e.g. eu-central"),
            ip_range: z.string().optional().describe("CIDR, e.g. 10.0.0.0/24; omit for auto /24"),
            vswitch_id: z.number().optional().describe("Required if type is vswitch"),
        },
        async ({ id, type, network_zone, ip_range, vswitch_id }, _extra) => withToolError(async () => {
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
        async ({ id, ip_range }, _extra) => withToolError(async () => {
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
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => VolumesService.getVolumes(p), "volumes");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "get_volume",
        "Get a single volume by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await VolumesService.getVolumes1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response.volume, null, 2) }] };
        })
    );

    server.tool(
        "create_volume",
        "Create a new volume (size in GB, min 10). Give location, or server to create it in the server's location and attach it right away. In responses, read assignee ({type, id}); the old server field goes away on 2027-10-27",
        {
            name: z.string(),
            size: z.number().describe("Size in GB (min 10)"),
            automount: z.boolean().optional().describe("Only with server: mount automatically"),
            format: z.enum(["xfs", "ext4"]).optional(),
            location: z.string().optional().describe("Location name, e.g. fsn1 (omit if server set)"),
            server: z.number().optional().describe("Server ID to attach to on creation (omit if location set)"),
            labels: z.record(z.string()).optional(),
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

    server.tool(
        "update_volume",
        "Update a volume (name, labels)",
        {
            id: z.number(),
            name: z.string().optional(),
            labels: z.record(z.string()).optional(),
        },
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await VolumesService.putVolumes({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "attach_volume",
        "Attach a volume to a server (must be in the same location). Returns an Action",
        {
            id: z.number(),
            server: z.number(),
            automount: z.boolean().optional(),
        },
        async ({ id, server, automount }, _extra) => withToolError(async () => {
            const response = await hcloudRequest("POST", `/volumes/${id}/actions/attach`, {
                body: { assignee: { type: "server", id: server }, automount },
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "detach_volume",
        "Detach a volume",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await VolumeActionsService.postVolumesActionsDetach({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_volume",
        "Delete a volume (must be detached; all data destroyed)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            await VolumesService.deleteVolumes({ id });
            return { content: [{ type: "text", text: "Volume deleted successfully" }] };
        })
    );

    // --- Firewalls ---
    server.tool(
        "list_firewalls",
        "List all firewalls",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => FirewallsService.getFirewalls(p), "firewalls");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "get_firewall",
        "Get a single firewall by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await FirewallsService.getFirewalls1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response.firewall, null, 2) }] };
        })
    );

    server.tool(
        "create_firewall",
        "Create a new firewall. Rules: direction 'in'|'out', protocol 'tcp'|'udp'|'icmp'|'esp'|'gre'; use source_ips for in, destination_ips for out (CIDRs, e.g. 0.0.0.0/0); port optional for tcp/udp. Optionally apply_to servers or label_selector at creation.",
        {
            name: z.string(),
            rules: z.array(firewallRuleSchema).optional(),
            apply_to: z.array(firewallApplyToSchema).optional().describe("Apply firewall to these servers or label_selector after creation"),
            labels: z.record(z.string()).optional(),
        },
        async (args, _extra) => withToolError(async () => {
            const body = {
                name: args.name,
                rules: args.rules,
                labels: args.labels,
                apply_to: args.apply_to,
            };
            const response = await FirewallsService.postFirewalls({ requestBody: body });
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
            await FirewallsService.deleteFirewalls({ id });
            return { content: [{ type: "text", text: "Firewall deleted successfully" }] };
        })
    );

    server.tool(
        "apply_firewall_to_resources",
        "Apply a firewall to servers or a label selector. Pass apply_to: [{ type: 'server', server: { id: 123 } }] or [{ type: 'label_selector', label_selector: { selector: 'env=web' } }].",
        {
            id: z.number().describe("Firewall ID"),
            apply_to: z.array(firewallApplyToSchema),
        },
        async ({ id, apply_to }, _extra) => withToolError(async () => {
            const response = await FirewallActionsService.postFirewallsActionsApplyToResources({ id, requestBody: { apply_to } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "remove_firewall_from_resources",
        "Remove a firewall from servers. Pass remove_from: [{ type: 'server', server: { id: 123 } }].",
        {
            id: z.number().describe("Firewall ID"),
            remove_from: z.array(z.object({
                type: z.literal("server"),
                server: z.object({ id: z.number() }),
            })),
        },
        async ({ id, remove_from }, _extra) => withToolError(async () => {
            const response = await FirewallActionsService.postFirewallsActionsRemoveFromResources({ id, requestBody: { remove_from } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "set_firewall_rules",
        "Set rules on an existing firewall (overwrites all rules). Same rule format as create_firewall.",
        {
            id: z.number().describe("Firewall ID"),
            rules: z.array(firewallRuleSchema),
        },
        async ({ id, rules }, _extra) => withToolError(async () => {
            const response = await FirewallActionsService.postFirewallsActionsSetRules({ id, requestBody: { rules } });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Floating IPs ---
    server.tool(
        "list_floating_ips",
        "List all floating IPs",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => FloatingIPsService.getFloatingIps(p), "floating_ips");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
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
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                type: args.type,
                home_location: args.home_location,
                server: args.server,
                description: args.description,
                labels: args.labels,
            };
            const response = await FloatingIPsService.postFloatingIps({ requestBody });
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
        async ({ id, description, labels }, _extra) => withToolError(async () => {
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
        async ({ id, server }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
            const response = await FloatingIpActionsService.postFloatingIpsActionsUnassign({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_floating_ip",
        "Delete a floating IP. Must be unassigned first (unassign_floating_ip), else fails with must_be_unassigned",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            await FloatingIPsService.deleteFloatingIps({ id });
            return { content: [{ type: "text", text: "Floating IP deleted successfully" }] };
        })
    );

    // --- Primary IPs ---
    server.tool(
        "list_primary_ips",
        "List all Primary IPs (static IPs bound to a location, assignable to one server)",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => PrimaryIPsService.getPrimaryIps(p), "primary_ips");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "create_primary_ip",
        "Create a Primary IP (location-scoped; server must be off to assign). Provide location OR assignee_id (server).",
        {
            name: z.string(),
            type: z.enum(["ipv4", "ipv6"]),
            location: z.string().optional().describe("Location name or ID, e.g. fsn1 (omit if assignee_id set)"),
            assignee_id: z.number().optional().describe("Server ID to assign to immediately (omit if location set)"),
            auto_delete: z.boolean().optional(),
            labels: z.record(z.string()).optional(),
        },
        async (args, _extra) => withToolError(async () => {
            const hasLocation = args.location != null && args.location !== "";
            const hasAssignee = args.assignee_id != null;
            if (hasLocation === hasAssignee) {
                throw new Error("Provide exactly one of location or assignee_id (mutually exclusive)");
            }
            // hetzner-sdk-ts 1.0.1 still models the removed `datacenter` field; the API
            // (since 2026-07-01) takes `location`. The SDK passes the body through as JSON.
            const requestBody = {
                name: args.name,
                type: args.type,
                location: args.location,
                assignee_id: args.assignee_id,
                ...(hasAssignee ? { assignee_type: "server" as const } : {}),
                auto_delete: args.auto_delete,
                labels: args.labels,
            } as unknown as Parameters<typeof PrimaryIPsService.postPrimaryIps>[0]["requestBody"];
            const response = await PrimaryIPsService.postPrimaryIps({ requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_primary_ip",
        "Get a single Primary IP by ID",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await PrimaryIPsService.putPrimaryIps({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_primary_ip",
        "Delete a Primary IP. Must be unassigned first (unassign_primary_ip, server powered off), else fails with must_be_unassigned",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, server }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
            const response = await PrimaryIpActionsService.postPrimaryIpsActionsUnassign({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- SSH Keys ---
    server.tool(
        "list_ssh_keys",
        "List all SSH keys",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => SshKeysService.getSshKeys(p), "ssh_keys");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "create_ssh_key",
        "Create a new SSH key (public_key is trimmed; the API rejects leading whitespace)",
        {
            name: z.string(),
            public_key: z.string(),
            labels: z.record(z.string()).optional(),
        },
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                // API rejects leading whitespace since 2026-04-22; pasted keys often carry it.
                public_key: args.public_key.trim(),
                labels: args.labels,
            };
            const response = await SshKeysService.postSshKeys({ requestBody });
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
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
        async ({ id }, _extra) => withToolError(async () => {
            await SshKeysService.deleteSshKeys({ id });
            return { content: [{ type: "text", text: "SSH key deleted successfully" }] };
        })
    );

    // --- General Info ---
    server.tool(
        "list_locations",
        "List all locations",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => LocationsService.getLocations(p), "locations");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "list_images",
        "List all images (check each image's `deprecation` field; deprecated images can stop being usable for new servers)",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => ImagesService.getImages(p), "images");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "list_server_types",
        "List all server types. Per-location availability is in locations[]: available, recommended, deprecation (top-level `deprecated` was removed)",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => ServerTypesService.getServerTypes(p), "server_types");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "list_load_balancer_types",
        "List all load balancer types (for create_load_balancer load_balancer_type; check `deprecation`)",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => LoadBalancerTypesService.getLoadBalancerTypes(p), "load_balancer_types");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.tool(
        "list_actions",
        "Get an action by ID with optional status filter. Hetzner no longer supports listing all actions in a project, so id is required. Prefer get_action",
        {
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
        async (args, _extra) => withToolError(async () => {
            const response = await ActionsService.getActions({
                id: args.id,
                status: args.status,
                sort: args.sort,
                page: args.page,
                perPage: args.per_page,
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_action",
        "Get a single action by ID (e.g. to check progress or status after create/delete)",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
            const response = await ActionsService.getActions1({ id });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "get_pricing",
        "Get all prices",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const response = await PricingService.getPricing();
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    // --- Placement Groups ---
    server.tool(
        "list_placement_groups",
        "List all placement groups",
        {},
        async (_args?, _extra?) => withToolError(async () => {
            const items = await listAll((p) => PlacementGroupsService.getPlacementGroups(p), "placement_groups");
            return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
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
        async (args, _extra) => withToolError(async () => {
            const requestBody = {
                name: args.name,
                type: args.type,
                labels: args.labels,
            };
            const response = await PlacementGroupsService.postPlacementGroups({ requestBody });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );

    server.tool(
        "delete_placement_group",
        "Delete a placement group",
        { id: z.number() },
        async ({ id }, _extra) => withToolError(async () => {
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
        async ({ id, name, labels }, _extra) => withToolError(async () => {
            const response = await PlacementGroupsService.putPlacementGroups({
                id,
                requestBody: { name, labels }
            });
            return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
        })
    );
}
