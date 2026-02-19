# hcloud-mcp

Standalone **MCP (Model Context Protocol) server** for the [Hetzner Cloud API](https://docs.hetzner.cloud/). Use it with any MCP client: Cursor, Claude Desktop, CLI tools, [smithery.ai](https://smithery.ai), or custom agents.

[Get Hetzner Cloud](https://hetzner.cloud/?ref=IAYKetqPnlq9) — new signups get €20 credit.

## Requirements

- Node.js 18+
- A [Hetzner Cloud](https://console.hetzner.cloud/) API token (project → Security → API Tokens). Set it as `HCLOUD_TOKEN` in the environment or in your MCP client config.

## Installation

### From source (clone this repo)

```bash
git clone <your-repo-url>
cd hcloud-mcp
npm install
npm run build
```

### After publishing to npm (optional)

```bash
npx hcloud-mcp
```

(Configure your MCP client to run `npx hcloud-mcp` with `HCLOUD_TOKEN` in env.)

## Configuration

Add the server to your MCP client configuration. The server speaks MCP over **stdio** and expects `HCLOUD_TOKEN` in the environment.

Example (`mcp.json` or your client’s equivalent):

```json
{
  "mcpServers": {
    "hetzner-cloud": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "HCLOUD_TOKEN": "your_hetzner_cloud_api_token"
      }
    }
  }
}
```

If you run from a different directory, use an absolute path for `args`, or use `npx hcloud-mcp` and set `"command": "npx", "args": ["hcloud-mcp"]` (after publishing).

## Tools

The server exposes Hetzner Cloud API operations as MCP tools.

| Area                   | Tools                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Servers**            | `list_servers`, `create_server`, `delete_server`, `update_server`, `change_server_type`; power: `power_on_server`, `power_off_server`, `reboot_server`, `shutdown_server`, `reset_server`; `attach_iso`, `detach_iso`; `attach_server_to_network`, `detach_server_from_network` |
| **Load Balancers**     | `list_load_balancers`, `create_load_balancer`, `update_load_balancer`, `delete_load_balancer`; `add_load_balancer_target`, `remove_load_balancer_target`; `add_load_balancer_service`, `delete_load_balancer_service`; `list_load_balancer_types`                               |
| **Networks**           | `list_networks`, `create_network`, `update_network`, `delete_network`; `add_network_subnet`, `delete_network_subnet`                                                                                                                                                            |
| **Volumes**            | `list_volumes`, `create_volume`, `update_volume`, `delete_volume`; `attach_volume`, `detach_volume`                                                                                                                                                                             |
| **Firewalls**          | `list_firewalls`, `create_firewall`, `update_firewall`, `delete_firewall`                                                                                                                                                                                                       |
| **Floating IPs**       | `list_floating_ips`, `create_floating_ip`, `update_floating_ip`, `delete_floating_ip`; `assign_floating_ip`, `unassign_floating_ip`                                                                                                                                             |
| **Primary IPs**        | `list_primary_ips`, `create_primary_ip`, `get_primary_ip`, `update_primary_ip`, `delete_primary_ip`; `assign_primary_ip`, `unassign_primary_ip` (server must be off)                                                                                                            |
| **SSH Keys**           | `list_ssh_keys`, `create_ssh_key`, `update_ssh_key`, `delete_ssh_key`                                                                                                                                                                                                           |
| **Placement Groups**   | `list_placement_groups`, `create_placement_group`, `update_placement_group`, `delete_placement_group`                                                                                                                                                                           |
| **Metadata & actions** | `list_locations`, `list_images`, `list_server_types`, `list_load_balancer_types`, `list_datacenters`, `get_pricing`; `list_actions`, `get_action` (poll async operations)                                                                                                       |

Networks are zone-scoped (e.g. eu-central); subnets and servers must be in the same zone.

## Usage examples

Once your MCP client is connected, you can ask the agent to run tools, for example:

- "List my Hetzner servers"
- "Create a cx22 server with Ubuntu 24.04 in nbg1"
- "Create a 10GB volume and attach it to server web-01"
- "List load balancer types"
- "Create a private network 10.0.0.0/16 in eu-central, add a subnet, then create two servers in that zone and attach them"
- "Get status of action 12345"

## Development

- `src/index.ts` — Entry point, stdio transport, `HCLOUD_TOKEN` check.
- `src/mcp-server.ts` — MCP server wrapper (tools registration, request handling).
- `src/register-tools.ts` — All tool definitions and Hetzner API calls.

```bash
npm run build   # compile
npm run start   # run (requires HCLOUD_TOKEN)
npm run dev     # watch and recompile
```

## License

MIT
