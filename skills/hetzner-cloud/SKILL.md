---
name: hetzner-cloud
description: Use when provisioning, changing, recovering, or tearing down Hetzner resources through the hcloud-mcp tools (servers, networks, firewalls, load balancers, volumes, IPs, DNS, certificates, snapshots, Storage Boxes), or when a Hetzner call fails with must_be_unassigned, locked, invalid_input, or a 410.
---

# Hetzner Cloud via hcloud-mcp

## Overview
Every mutating tool returns an **Action**, and Actions run asynchronously. Most failures come from starting the next step before the previous Action has finished, or from doing steps in the wrong order. Wait on each dependency, and follow the orders below.

## Waiting on an Action
After any create, delete, attach, detach, assign, unassign, or power call, read `action.id` from the response. Then call `get_action {id}` until `status` is `success`. If it is `error`, stop and report `action.error`. Only start a step that depends on that resource after `success`. Steps that don't depend on each other can run without waiting. If the response has no `action`, the call finished synchronously. `create_network` is one of these. If it has `actions` or `next_actions`, wait on each one.

## Argument shapes
| Tool | Shape |
|---|---|
| `create_server` | `location` such as `fsn1`. Never `datacenter`, which was removed. `ssh_keys: ["name" or id]`, `networks: [netId]`, `firewalls: [{"firewall": fwId}]`, `volumes: [volId]` |
| `create_primary_ip` | Exactly one of `location` or `assignee_id` |
| `add_network_subnet` | `type: "cloud"`. `network_zone` must match the server's location: `eu-central` for fsn1, nbg1 and hel1; `us-east` for ash; `us-west` for hil; `ap-southeast` for sin |
| firewall rules | `{direction, protocol, port, source_ips}`. CIDRs must have zero host bits: `203.0.113.57/32`, not `/24`. If the user wrote `x.y.z.57/24`, ask whether they mean that one host (`/32`) or the whole range (`x.y.z.0/24`) |
| networks | `create_network` creates no subnet. Call `add_network_subnet` and wait for it to finish before you attach servers |

## Choosing a type and an image
Call `list_server_types` and pick a type whose `locations[]` entry for your location has `available: true` and `deprecation: null`. Call `list_images` and skip any image whose `deprecation` is set. The image's `architecture` must match the type's architecture (`x86` or `arm`). Use `get_pricing` to find the cheapest option in a location. Don't hardcode type names, because Hetzner retires them.

## Required orders
**Swap a Primary IP:** create the new IP in the same location → `shutdown_server` (wait for the Action) → `unassign_primary_ip` (wait) → `assign_primary_ip` (wait) → `power_on_server` → `delete_primary_ip` on the old IP. This takes the server offline, and the old address can't be recovered, so confirm with the user first. If `shutdown_server` doesn't finish within about 2 minutes, ask the user before you `power_off_server`.

**Teardown:**
1. `delete_load_balancer` (wait)
2. `unassign_floating_ip` (wait) → `delete_floating_ip`
3. `detach_volume` (wait) → `delete_volume`
4. `delete_server` (wait)
5. `delete_network`, `delete_firewall`, and unassigned primary IPs

Deleting an assigned IP fails with `must_be_unassigned`.

**Filtering by label:** no list tool takes a `label_selector`. Call the list tool for each resource type, including firewalls and primary IPs, then filter on `labels` yourself. List tools return every page.

## DNS
- **Zone and RRSet references:** refer to a zone by name (`example.com`) or by ID. RRSet `name` is relative to the zone: `@` is the apex, `www` is www.example.com. Use lowercase.
- **Record values** use zone-file syntax:
  - TXT values must be quoted, e.g. `"\"v=spf1 -all\""`.
  - MX values look like `"10 mail.example.com."`.
  - A record pointing at a server: use the IP from `get_server`, at `public_net.ipv4.ip`.
- **Picking the right tool:**

  | Task | Tool |
  |---|---|
  | Add a record | `add_rrset_records` (creates the RRSet if it's missing) |
  | Replace all records | `set_rrset_records` |
  | Drop one record | `remove_rrset_records` (removing the last record deletes the RRSet) |
  | Change a record's comment | `update_rrset_records` |

- **Back up before bulk changes:** `export_zonefile`, then `import_zonefile`. Import replaces every RRSet in the zone. Never import a partial file.
- **A new zone answers nothing yet.** Tell the user to point the domain's nameservers at the registrar to `get_zone.authoritative_nameservers.assigned`.
- **Errors:** `protected` means `change_rrset_protection` or `change_zone_protection` is on; ask the user before turning it off. `incorrect_zone_mode` means you tried a record edit on a secondary zone.

## Recovery, snapshots, protection
- **Before a risky change** (`rebuild_server`, `change_server_type`): power the server off → `create_snapshot` (wait for it to finish) → make the change. Find and clean up snapshots later with `list_snapshots`, since they bill per GB-month.
- **Locked out of a server:** first try `reset_root_password`, which needs the qemu guest agent; stock images have it. If that fails: `enable_rescue` → wait for the Action → `reset_server` → fix things from the rescue system. Rescue switches itself off after one boot. `request_console` gives a browser VNC URL that must be used within 60 seconds.
- **Secrets:** passwords and console URLs go to the user only. Never write them to files, labels, or later tool arguments.
- **Protection:** use `change_protection(resource, id, delete)`. On servers it also sets rebuild protection, because the API requires both to match. Only remove protection after the user confirms.
- **Backups:** `disable_server_backups` deletes every existing backup. To keep one, run `update_image type:"snapshot"` on it first.

## Metrics
Call `get_server_metrics` or `get_load_balancer_metrics` with `last_minutes` and `include_values:false` to get the summary first. Pull the raw series only if something looks off. CPU is per vCPU: 200 means two full cores.

## Certificates and load balancer HTTPS
- **Managed (Let's Encrypt):** the domain must be in a primary Hetzner DNS zone that is delegated to Hetzner. Steps: `create_zone` → user delegates it at the registrar → `create_certificate type:managed` → poll `get_action`. Hetzner renews it automatically.
- **Uploaded:** certificates never renew. To rotate, create the new cert, point the LB service at it via `update_load_balancer_service http.certificates`, then delete the old one. Check `used_by` before deleting any certificate.

## Storage Boxes
- **Where they live:** `api.hetzner.com`, using the same token. Poll their actions with `get_storage_box_action`, and wait for the box's `status: active`.
- **Passwords:** 12–128 characters, with upper case, lower case, a digit and a special character. Generate a random one rather than inventing a memorable one. A password reset locks out existing clients.
- **Irreversible actions:** `rollback_storage_box_snapshot` discards newer snapshots and all data written since. `delete_storage_box` removes everything. Confirm first, and suggest `change_storage_box_protection`.

## Labels and network changes
- **Labels:** every `update_*` replaces the whole label set. Read the current labels and merge.
- **Alias IPs:** `change_server_alias_ips` replaces the whole list. Send the existing IPs plus the new one.
- **Placement groups:** `add_server_to_placement_group` needs the server powered off. Removing works while it runs.
- **Network ranges:** `change_network_ip_range` can only widen the range (e.g. /16 → /15), and needs every member detached first.

## Common mistakes
| Symptom | Cause and fix |
|---|---|
| `locked` or `conflict` | Another Action is still running on the resource. Wait for it, then retry |
| `must_be_unassigned` | Unassign the IP first, and wait for that Action |
| `invalid_input` on a firewall | A CIDR has host bits set |
| Server can't join the network | The subnet's `network_zone` doesn't match the server's location |
| `protected` | Delete protection is on. Ask the user before you change it |

## Safety
Deletes, `rebuild_server` (wipes the disk), `import_zonefile`, `rollback_storage_box_snapshot`, `disable_server_backups`, `reset_server`, `power_off_server`, and `change_server_type` can't be undone. Before you run any of them, list exactly what will be affected and get the user's confirmation.
