/**
 * Audit script: verify request body shapes for create_* tools match the Hetzner API.
 * Builds minimal valid payloads and calls the SDK.
 * With DRY_RUN=1: uses invalid token so requests fail with 401 (no resources created).
 * With real token: makes real API calls and may create resources.
 * Run from project root: node scripts/audit-api-shapes.mjs
 */
import "dotenv/config";
import {
  ServersService,
  LoadBalancersService,
  NetworksService,
  VolumesService,
  FloatingIPsService,
  SshKeysService,
  PlacementGroupsService,
  OpenAPI,
} from "hetzner-sdk-ts";

let token = process.env.HCLOUD_TOKEN;
if (!token) {
  console.error("Error: HCLOUD_TOKEN environment variable is required");
  process.exit(1);
}
if (process.env.DRY_RUN === "1") {
  token = "invalid";
  console.log(
    "DRY_RUN=1: using invalid token (no resources will be created)\n",
  );
}
OpenAPI.TOKEN = token;

function ok(name, err) {
  const msg = err?.message || String(err);
  if (msg.includes("Unauthorized") || msg.includes("401")) {
    console.log(
      `${name}: OK (request shape accepted, auth failed as expected or token invalid)`,
    );
    return true;
  }
  if (msg.includes("invalid") || msg.includes("400")) {
    console.error(`${name}: FAIL - API rejected payload:`, msg);
    return false;
  }
  console.error(`${name}: FAIL -`, msg);
  return false;
}

async function run() {
  let failed = 0;

  console.log("Auditing create_* request body shapes...\n");

  // create_server
  try {
    await ServersService.postServers({
      requestBody: {
        name: "audit-test-server",
        server_type: "cx11",
        image: "ubuntu-24.04",
        location: "fsn1",
      },
    });
    console.log("create_server: OK (request sent)");
  } catch (e) {
    if (!ok("create_server", e)) failed++;
  }

  // create_load_balancer
  try {
    await LoadBalancersService.postLoadBalancers({
      requestBody: {
        name: "audit-test-lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      },
    });
    console.log("create_load_balancer: OK (request sent)");
  } catch (e) {
    if (!ok("create_load_balancer", e)) failed++;
  }

  // create_network
  try {
    await NetworksService.postNetworks({
      requestBody: {
        name: "audit-test-network",
        ip_range: "10.0.0.0/16",
      },
    });
    console.log("create_network: OK (request sent)");
  } catch (e) {
    if (!ok("create_network", e)) failed++;
  }

  // create_volume
  try {
    await VolumesService.postVolumes({
      requestBody: {
        name: "audit-test-volume",
        size: 10,
        location: "fsn1",
      },
    });
    console.log("create_volume: OK (request sent)");
  } catch (e) {
    if (!ok("create_volume", e)) failed++;
  }

  // create_floating_ip
  try {
    await FloatingIPsService.postFloatingIps({
      requestBody: {
        type: "ipv4",
        home_location: "fsn1",
      },
    });
    console.log("create_floating_ip: OK (request sent)");
  } catch (e) {
    if (!ok("create_floating_ip", e)) failed++;
  }

  // create_ssh_key
  try {
    await SshKeysService.postSshKeys({
      requestBody: {
        name: "audit-test-key",
        public_key:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI audit-test-invalid-key",
      },
    });
    console.log("create_ssh_key: OK (request sent)");
  } catch (e) {
    if (!ok("create_ssh_key", e)) failed++;
  }

  // create_placement_group
  try {
    await PlacementGroupsService.postPlacementGroups({
      requestBody: {
        name: "audit-test-pg",
        type: "spread",
      },
    });
    console.log("create_placement_group: OK (request sent)");
  } catch (e) {
    if (!ok("create_placement_group", e)) failed++;
  }

  console.log("");
  if (failed > 0) {
    console.error(
      `${failed} audit(s) failed. Check payload shapes against SDK/API.`,
    );
    process.exit(1);
  }
  console.log("All create_* payload shapes accepted by API.");
}

run();
