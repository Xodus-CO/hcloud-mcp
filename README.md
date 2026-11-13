# HCloud MCP

[![Hcloud MCP server](https://mcprush.com/badge/hcloud-mcp/card.svg)](https://mcprush.com/to/hcloud-mcp?ref=badge)

Standalone **MCP (Model Context Protocol) server** for the [Hetzner Cloud API](https://docs.hetzner.cloud/): servers, networking, load balancers, volumes, DNS, certificates, snapshots and Storage Boxes. It has 162 tools, and every tool tells the client whether it is read-only or destructive. Use it with any MCP client: Cursor, Claude Desktop, Claude Code, CLI tools, [smithery.ai](https://smithery.ai), or custom agents.

- **Repository:** [github.com/Xodus-CO/hcloud-mcp](https://github.com/Xodus-CO/hcloud-mcp)
- **Hetzner Cloud:** [Get started](https://hetzner.cloud/?ref=IAYKetqPnlq9) — new signups get €20 credit.

---

## Requirements

- Node.js 18+
- A Hetzner Cloud API token. [Generate one](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token) in the console (project → Security → API Tokens). Set it as `HCLOUD_TOKEN` in the environment or in your MCP client config. A token gives access to the whole project. If the agent only needs to look things up, create a **Read** token instead of Read & Write.

The server runs locally over stdio. Your token is only sent to Hetzner's API (`api.hetzner.cloud` and `api.hetzner.com`).

## Installation

### From npm (recommended)

```bash
npm install -g hcloud-mcp
```

Or use `npx` to run without a global install.

### From source

```bash
git clone https://github.com/Xodus-CO/hcloud-mcp
cd hcloud-mcp
npm install
npm run build
```

## Configuration

Add the server to your MCP client config. It uses MCP over **stdio** and requires `HCLOUD_TOKEN` in the environment.

**Example** — `mcp.json` (or your client’s equivalent) using the npm binary:

```json
{
  "mcpServers": {
    "hetzner-cloud": {
      "command": "npx",
      "args": ["-y", "hcloud-mcp@latest"],
      "env": {
        "HCLOUD_TOKEN": "your_hetzner_cloud_api_token"
      }
    }
  }
}
```

If you installed from source, use an **absolute path** to `run.js` in `args` so the server runs from the project directory (e.g. when the MCP client’s CWD is different, as in dev containers):

```json
"command": "node",
"args": ["/path/to/hcloud-mcp/run.js"]
```

Replace `/path/to/hcloud-mcp` with your actual project path (e.g. `/home/<username>/hcloud-mcp`).

## Tools

The server exposes Hetzner Cloud API operations as MCP tools:

| Area                   | Tools                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Servers**            | `list_servers`, `get_server`, `create_server`, `delete_server`, `update_server`, `change_server_type`; power: `power_on_server`, `power_off_server`, `reboot_server`, `shutdown_server`, `reset_server`; `attach_iso`, `detach_iso`; `attach_server_to_network`, `detach_server_from_network`; `rebuild_server`; reverse DNS: `change_dns_ptr` (also Primary/Floating IPs, LBs)          |
| **Load Balancers**     | `list_load_balancers`, `get_load_balancer`, `create_load_balancer`, `update_load_balancer`, `delete_load_balancer`; `add_load_balancer_target`, `remove_load_balancer_target`; `add_load_balancer_service`, `update_load_balancer_service`, `delete_load_balancer_service`; `list_load_balancer_types`. `create_load_balancer` can set an existing Primary IP (`public_net`), a private network, services and targets in one call. `update_load_balancer_service` supports `http.timeout_idle` |
| **Networks**           | `list_networks`, `get_network`, `create_network`, `update_network`, `delete_network`; `add_network_subnet`, `delete_network_subnet`; `list_network_members`                                                                                                                                                                    |
| **Volumes**            | `list_volumes`, `get_volume`, `create_volume`, `update_volume`, `delete_volume`; `attach_volume`, `detach_volume`                                                                                                                                                                                      |
| **Firewalls**          | `list_firewalls`, `get_firewall`, `create_firewall`, `update_firewall`, `delete_firewall`; `apply_firewall_to_resources`, `remove_firewall_from_resources`, `set_firewall_rules`                                                                                                                       |
| **Floating IPs**       | `list_floating_ips`, `create_floating_ip`, `update_floating_ip`, `delete_floating_ip`; `assign_floating_ip`, `unassign_floating_ip`                                                                                                                                                                    |
| **Primary IPs**        | `list_primary_ips`, `create_primary_ip`, `get_primary_ip`, `update_primary_ip`, `delete_primary_ip`; `assign_primary_ip`, `unassign_primary_ip` (server must be off)                                                                                                                                   |
| **SSH Keys**           | `list_ssh_keys`, `create_ssh_key`, `update_ssh_key`, `delete_ssh_key`                                                                                                                                                                                                                                  |
| **Placement Groups**   | `list_placement_groups`, `create_placement_group`, `update_placement_group`, `delete_placement_group`                                                                                                                                                                                                  |
| **DNS** | `list_zones`, `get_zone`, `create_zone`, `update_zone`, `delete_zone`; `export_zonefile`, `import_zonefile`; `change_zone_ttl`, `change_zone_primary_nameservers`, `change_zone_protection`; `list_rrsets`, `get_rrset`, `create_rrset`, `update_rrset`, `delete_rrset`; `set_rrset_records`, `add_rrset_records`, `remove_rrset_records`, `update_rrset_records`, `change_rrset_ttl`, `change_rrset_protection` |
| **Snapshots & backups** | `create_snapshot`, `list_snapshots`, `get_image`, `update_image`, `delete_image`; `enable_server_backups`, `disable_server_backups` |
| **Protection** | `change_protection` (servers, volumes, floating/primary IPs, LBs, networks, images) |
| **Rescue & console** | `enable_rescue`, `disable_rescue`, `reset_root_password`, `request_console` |
| **Metrics** | `get_server_metrics`, `get_load_balancer_metrics` (with min/avg/max summary; `last_minutes` shortcut) |
| **More actions** | `add_server_to_placement_group`, `remove_server_from_placement_group`, `change_server_alias_ips`; `attach_load_balancer_to_network`, `detach_load_balancer_from_network`, `change_load_balancer_algorithm`, `change_load_balancer_type`, `enable_load_balancer_public_interface`, `disable_load_balancer_public_interface`; `add_network_route`, `delete_network_route`, `change_network_ip_range`; `list_isos` |
| **Certificates** | `list_certificates`, `get_certificate`, `create_certificate` (uploaded or managed Let's Encrypt), `update_certificate`, `delete_certificate`, `retry_certificate` |
| **Storage Boxes** | boxes: `list_storage_boxes`, `get_storage_box`, `create_storage_box`, `update_storage_box`, `delete_storage_box`, `list_storage_box_folders`, `list_storage_box_types`, `get_storage_box_type`; actions: `change_storage_box_type`, `change_storage_box_protection`, `reset_storage_box_password`, `update_storage_box_access_settings`, `enable_storage_box_snapshot_plan`, `disable_storage_box_snapshot_plan`, `rollback_storage_box_snapshot`, `list_storage_box_actions`, `get_storage_box_action`; subaccounts (`*_storage_box_subaccount*`) and snapshots (`*_storage_box_snapshot*`) |
| **Metadata & actions** | `list_locations`, `list_images`, `list_server_types`, `list_load_balancer_types`, `get_pricing`; `list_actions`, `get_action` (poll async operations)                                                                                                                              |

> **Note:** Subnets (not networks) are scoped to a `network_zone` (e.g., `eu-central`). Each Subnet has a `network_zone`; all Subnets within a Network share the same `network_zone`. Servers must be created in locations that match the Subnet's `network_zone`, so resources in the Network are constrained by the shared subnet `network_zone`.

### Limiting tools (`HCLOUD_TOOLSETS`)

The server exposes 162 tools. Some MCP clients cap the total number of tools, or slow down with very many. Set `HCLOUD_TOOLSETS` to load only the groups you need. The `core` group is always loaded.

| Toolset | Contents |
|---|---|
| `core` | Servers, networks, firewalls, volumes, LBs, IPs, SSH keys, placement groups, reverse DNS, metadata, and extra actions |
| `dns` | DNS zones and RRSets |
| `images` | Snapshots, backups, image management, `change_protection` |
| `ops` | Rescue, console, root password, metrics |
| `certificates` | TLS certificates |
| `storage_boxes` | Storage Boxes, subaccounts, snapshots |

Example: `"env": { "HCLOUD_TOKEN": "...", "HCLOUD_TOOLSETS": "dns,images" }`. If you leave it unset, or set it to `all`, everything loads. `core` alone is 91 tools; `core` plus `dns` is 112.

### Tool annotations

Every tool declares MCP [tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations), which clients can use to decide when to ask for confirmation:

| Annotation | Tools | Examples |
|---|---|---|
| `readOnlyHint` | 46 | Every `list_*`, `get_*` and `export_*` tool |
| `destructiveHint` | 57 | Deletes, `rebuild_server`, `power_off_server`, `import_zonefile`, `rollback_storage_box_snapshot`, `disable_server_backups` |
| `idempotentHint` | 92 | Changes that are safe to repeat, such as deletes, `power_off_server`, `set_firewall_rules` and `set_rrset_records` |

All tools also set `openWorldHint`, because they call an external API. These are hints, not guarantees. Keep confirmation turned on for destructive tools.

### Server instructions and agent skill

The server sends **instructions** to the client when it connects. Most MCP clients add them to the model's context. They cover using locations instead of datacenters, polling Actions, the order to detach resources before deleting them, firewall CIDR rules, and deprecation checks. See `src/instructions.ts`.

For deeper guidance, install the bundled skill **`hetzner-cloud`** (`skills/hetzner-cloud/SKILL.md`). It covers argument shapes, the required order for Primary IP swaps and teardowns, and fixes for common errors.

```bash
# Claude Code (personal skills)
mkdir -p ~/.claude/skills && cp -r skills/hetzner-cloud ~/.claude/skills/
# or from an npm install:
cp -r "$(npm root -g)/hcloud-mcp/skills/hetzner-cloud" ~/.claude/skills/
```

The skill is also included in the npm package.

## API compatibility

The tools follow the Hetzner API as of November 2026 ([Hetzner changelog](https://docs.hetzner.cloud/changelog)):

- **Locations, not datacenters.** `list_datacenters` is gone, because the endpoint returns 410 Gone. `create_server` and `create_primary_ip` take `location`.
- **Volumes:** `create_volume` and `attach_volume` send `assignee: {type: "server", id}`, because Hetzner removes the old `server` field on 2027-10-27. Read `assignee` in volume responses.
- **List tools return every page**, not just the first 25 items.
- **`list_actions` requires `id`**, because Hetzner removed project-wide action listing. Use `get_action` to poll an Action.
- **Unassign before deleting.** Floating IPs and Primary IPs must be unassigned before you delete them.
- **Errors** come back as `code (status): message`, for example `not_found (404): server not found`.

Hetzner Robot (dedicated servers) is not covered yet; see [#21](https://github.com/Xodus-CO/hcloud-mcp/issues/21).

## Changelog

See [GitHub Releases](https://github.com/Xodus-CO/hcloud-mcp/releases) for full notes.

- **0.4.0:** Removed the Hetzner SDK dependency; every tool now calls the API through one small fetch client. Every tool declares MCP annotations. `create_load_balancer` accepts an existing Primary IP, a network, services and targets.
- **0.3.1:** Volumes use `assignee`. CI added. (Not published to npm separately; included in 0.4.0.)
- **0.3.0:** Added DNS, Storage Boxes, certificates, snapshots and backups, rescue and console, metrics, and the remaining server, network and load balancer actions. Added `HCLOUD_TOOLSETS`.
- **0.2.0:** Updated for 2026 Hetzner API changes (above). Added server instructions and the `hetzner-cloud` skill.

## Usage examples

With the MCP client connected, you can ask the agent to run tools using natural language.

### Simple

- _List my servers in Nuremberg_
- _Create the cheapest available server in fsn1 with Ubuntu 24.04_
- _Create a small Ubuntu 24.04 server using my SSH key 'macbook'_
- _Attach a 10GB volume to web-01_
- _Set up a load balancer for my web servers_
- _List load balancer types_
- _Show current pricing for cpx31 servers_
- _Get status of action 12345_
- _Add an A record for www.example.com pointing to my web-01 server_
- _Export the zone file for example.com_

### Complex

- _Create a private network 10.0.0.0/16 in eu-central, add a subnet, then create two servers in that zone (e.g. fsn1 and nbg1) and attach them_
- _Create a firewall for SSH and HTTP, attach to my web servers, then create a load balancer and add those servers as targets_
- _Create a Primary IP in ash, power off web-01, assign the IP, power back on_
- _Create a 20GB volume and a small server in nbg1, attach the volume to the server, and show me the device path_
- _Power off server 12345, change its type to cpx31, then power it back on_
- _Add server web-02 as a target to my load balancer prod-lb_
- _Create a Primary IP in fsn1 and a load balancer that uses it, then add web-01 and web-02 as targets on port 80_
- _Snapshot web-01 before I rebuild it with Debian 12_
- _Create a Storage Box subaccount for backups with its own password and SSH access only_
- _Tear down: detach/delete volumes, delete LB and firewall, unassign/delete floating IPs, delete servers web-01 and web-02_

## Development

| File                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `src/index.ts`          | Entry point, stdio transport, `HCLOUD_TOKEN` check, `HCLOUD_TOOLSETS` |
| `src/tool-helpers.ts`   | Shared helpers: annotation presets, pagination (`listAll`), error formatting |
| `src/register-tools.ts` | Core tools: servers, LBs, networks, volumes, firewalls, IPs, SSH keys, info |
| `src/extra-tools.ts`    | Newer Cloud API endpoints (reverse DNS, rebuild, network members) |
| `src/dns-tools.ts`      | DNS zone/RRSet tools                                        |
| `src/hcloud-api.ts`     | Minimal fetch client for the Hetzner APIs (no SDK dependency) |
| `src/action-gap-tools.ts` | Placement groups, alias IPs, LB network/type/algorithm/public interface, routes, ISOs |
| `src/image-tools.ts`    | Snapshots, backups, image management, `change_protection` |
| `src/server-ops-tools.ts` | Rescue, console, root password, server/LB metrics |
| `src/certificate-tools.ts` | TLS certificates |
| `src/storage-box-tools.ts` | Storage Boxes (api.hetzner.com, same token) |
| `src/instructions.ts`   | Server instructions sent to MCP clients at initialize       |
| `skills/hetzner-cloud/` | Agent skill (SKILL.md) for driving this server safely        |

**Scripts:**

```bash
npm run build   # compile
npm run start   # run (requires HCLOUD_TOKEN)
npm run dev     # watch and recompile
npm run test:smoke # offline: server starts, 162 tools register with annotations, toolsets work (runs in CI)
npm run test:api   # read-only checks of the API client: pagination, error format (requires HCLOUD_TOKEN, run build first)
npm run test:mcp   # integration test: MCP client calls list_locations (requires HCLOUD_TOKEN)
npm run test:live:dns  # DNS create→teardown on a throwaway zone (free)
npm run test:live:images    # snapshots, backups, protection (costs cents)
npm run test:live:ops       # rescue, console, root password, metrics (costs cents)
npm run test:live:actions   # placement groups, alias IPs, LB/network actions, ISOs (costs cents)
npm run test:live:certs     # uploaded self-signed certificate lifecycle (free)
npm run test:live:storage   # Storage Box lifecycle on a new bx11 (fractions of a cent; never touches existing boxes)
npm run test:live  # full create→teardown cycle via MCP (COSTS a few cents; resources get a unique per-run hcloud-mcp-test label, auto-cleaned)
```

## License

MIT
