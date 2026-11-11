// Cloud API endpoints: reverse DNS (PTR), rebuild, network members.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hcloudRequest } from "./hcloud-api.js";
import { json, listAll, withToolError } from "./tool-helpers.js";

const PTR_RESOURCES = {
    server: "servers",
    primary_ip: "primary_ips",
    floating_ip: "floating_ips",
    load_balancer: "load_balancers",
} as const;

export function registerExtraTools(server: McpServer) {
    server.tool(
        "change_dns_ptr",
        "Set or reset reverse DNS (PTR) for a public IP of a server, Primary IP, Floating IP, or load balancer. dns_ptr is always required: pass a hostname to set it, or null to reset it to the Hetzner default. Returns an Action",
        {
            resource: z.enum(["server", "primary_ip", "floating_ip", "load_balancer"]),
            id: z.number().describe("ID of the server / Primary IP / Floating IP / load balancer"),
            ip: z.string().describe("The public IP to set the PTR for (IPv4, or a single IPv6 address within the resource's /64)"),
            dns_ptr: z.string().nullable().describe("Hostname, e.g. mail.example.com; null resets to default"),
        },
        async ({ resource, id, ip, dns_ptr }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/${PTR_RESOURCES[resource]}/${id}/actions/change_dns_ptr`, { body: { ip, dns_ptr } }))),
    );

    server.tool(
        "rebuild_server",
        "Reinstall a server from an image, WIPING ALL DATA on its disk (attached volumes are kept). The server keeps its ID and IPs. Optional user_data (cloud-init) overrides the original. Returns an Action and, for images that use one, a new root_password. Irreversible; confirm with the user first",
        {
            id: z.number().describe("Server ID"),
            image: z.string().describe("Image name or ID, e.g. ubuntu-24.04 (check list_images deprecation)"),
            user_data: z.string().optional().describe("Cloud-Init user data (max 32KiB)"),
        },
        async ({ id, image, user_data }) => withToolError(async () =>
            json(await hcloudRequest("POST", `/servers/${id}/actions/rebuild`, { body: { image, user_data } }))),
    );

    server.tool(
        "list_network_members",
        "List resources attached to a network (servers and load balancers) with their private IP, alias IPs, subnet and attachment status. All pages",
        {
            id: z.number().describe("Network ID"),
            // Each filter may be given multiple times (OR within a filter), per the API spec.
            type: z.array(z.enum(["server", "load_balancer"])).optional(),
            subnet: z.array(z.string()).optional().describe("Subnet IP ranges in CIDR, e.g. [\"10.0.1.0/24\"]"),
            status: z.array(z.enum(["ok", "attaching", "detaching", "updating", "error"])).optional()
                .describe("Attachment status (spec enum: ok, attaching, detaching, updating, error)"),
        },
        async ({ id, ...filters }) => withToolError(async () => {
            const members = await listAll(
                (p) => hcloudRequest("GET", `/networks/${id}/members`, { query: { ...filters, ...p } }),
                "members",
            );
            return json(members);
        }),
    );
}
