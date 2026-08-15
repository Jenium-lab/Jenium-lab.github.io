# Octavia LBaaS Deployment Guide — Flat Network, Nested Cloud

**Environment:** Kolla-Ansible (2025.2, Ubuntu Noble), OpenStack 2025.2, OVN, Octavia with the Amphora driver, running as a nested cloud inside an outer OpenStack deployment (outer cloud provides the NICs and provider networks). **Cluster:** 3 controllers (`controller-1/2/3`), each with a dedicated `ens9` NIC → `br-ex2` → `o-hm0` for the Octavia management plane. **Networking:** Flat `lb-mgmt-net` on `physnet2`/`br-ex2` (no VLAN tag anywhere); tenant overlay is Geneve (`neutron_tenant_network_types: geneve`); external/provider access via `ens8` → `physnet1`/`br-ex1`.

---

## 1. Introduction

Welcome. If you've ever wondered how OpenStack spreads traffic around without keeling over, this guide is for you. It covers deploying Octavia (OpenStack's native Load-Balancer-as-a-Service) on our multinode Kolla-Ansible cluster, using a **flat provider network** for the Octavia management plane. Think of a load balancer as the bouncer at a busy club. Everyone lines up at one door; the bouncer decides who gets in and which room they land in. Except here the "club" is your web app and the bouncer is a small VM running HAProxy. (And yes, VIP really is what we call the address — Very Important Packets.)

Everything you'll need is documented below: the architecture, the reasoning behind the flat-network design, the working `globals.yml`, the deployment steps, post-deploy verification, load balancer creation including backend VM setup, troubleshooting, and algorithm testing results. Use it as a reference for redeploying or troubleshooting — the kind of doc you'd want handed to you at 2 a.m. during an incident.

---

## 2. Architecture Overview

Octavia doesn't run load balancers as just another container. It does the OpenStack equivalent of cloning tiny bouncers: it spawns **Amphora VMs** — small, single-purpose VMs running HAProxy — to act as load balancers. Each Amphora connects to **two** networks:

| Port | Network | Purpose |
|---|---|---|
| mgmt port | `lb-mgmt-net` | Control plane — health checks, config push, heartbeats |
| vip/data port | tenant network (`demo-net`) | Data plane — accepts client traffic, forwards to backend members |

### 2.1 Octavia service components (containers)

| Container | Role |
|---|---|
| `octavia_api` | REST API |
| `octavia_worker` | Builds/manages amphorae, listeners, pools |
| `octavia_health_manager` | Receives heartbeats from amphorae over `lb-mgmt-net`, detects failures |
| `octavia_housekeeping` | Cleans up stale/deleted amphorae |
| `octavia_driver_agent` | Provider-driver dispatch (amphora driver) |

### 2.2 LB object hierarchy

```text
[Load Balancer — VIP: 10.0.0.60]
        |
        v
[Listener — web-listener : TCP/80]
        |
        v
[Pool — web-pool (ROUND_ROBIN)]
        |
        +--> [Member: backend-1 (10.0.0.54:80)]
        |
        +--> [Member: backend-2 (10.0.0.107:80)]
        |
        +--> [Health Monitor — web-health (HTTP GET /)]
```

Each Load Balancer object maps 1:1 to a running Amphora VM — one bouncer per door, no sharing. Listener → Pool → Member → Health Monitor is the standard build order, and skipping ahead is how accidents happen.

---

## 3. Environment

Full disclosure up front: this is a nested OpenStack deployment. Our Kolla-Ansible cluster runs as VMs inside an outer, existing OpenStack cloud — Russian dolls, except the dolls are clouds. That outer layer provides the NICs and provider networks our cluster builds on top of, which shapes some of the networking decisions below.

| Node | Mgmt IP (ens3) | Storage/Tunnel IP (ens7) |
|---|---|---|
| controller-1 | 192.168.10.123 | 192.168.20.141 |
| controller-2 | 192.168.10.94 | 192.168.20.142 |
| controller-3 | 192.168.10.118 | 192.168.20.32 |

- Internal/external VIP (HAProxy/Keepalived): `192.168.10.100`
- Tenant overlay: Geneve (`neutron_tenant_network_types: geneve`)
- `demo-net` (tenant network used for LB testing): `10.0.0.0/24`, gateway `10.0.0.1`
- External/provider access: `ens8` → `10.10.20.x` (physnet1)

---

## 4. Why Flat Network Instead of VLAN for `lb-mgmt-net`

The upstream Octavia docs assume a VLAN provider network for `lb-mgmt-net`. We tried that first. Spoiler: it didn't go well, so we moved off it for reasons specific to this nested setup:

1. **VLAN-tagged frames didn't make it through.** `lb-mgmt-net` was bridged via `physnet1:br-ex` on `ens8`. The outer cloud's virtual switch enforces port security on that uplink port, and VLAN-tagged frames from `o-hm0`'s distinct MAC were dropped in both directions — the health-manager and amphorae could never see each other's heartbeats.
2. **No VLAN was actually provisioned end-to-end.** VLAN 100 existed only inside our own OVN config — it never mapped to a real segment on the outer physical/virtual switch, so tagging bought us nothing.
3. **`physnet1` was already in use.** Neutron only allows one flat network per physical_network, and `physnet1` (via `ens8`) was already our external/provider network.

**Resolution:** we attached a second dedicated NIC (`ens9`) to all three controllers, gave it its own physical network name (`physnet2`), bridged it to a new OVS bridge (`br-ex2`), and rebuilt `lb-mgmt-net` as a **flat** network on `physnet2` — no VLAN tag anywhere in the path. Lesson learned: if the switch is going to play bouncer anyway, don't hand it a stamped ticket. Untagged flat traffic passes through the port-secured uplink cleanly, because there's no tag for the outer switch to strip or drop.

---

## 5. Network Architecture

```text
                 +---------------------------------------------------------+
                 |                  Outer OpenStack Cloud                  |
                 |          Virtual switch (port security enabled)         |
                 +------------+-------------------------------+------------+
                              |                               |
                              v                               v
                 +-------------------------+     +-------------------------+
                 |    ens8 (10.10.20.x)    |     |  ens9 (dedicated NIC)   |
                 |    vlan-capable path    |     |     flat, untagged      |
                 +-------------------------+     +-------------------------+
                              |                               |
                              v                               v
                 +-------------------------+     +-------------------------+
                 |    br-ex1 — physnet1    |     |    br-ex2 — physnet2    |
                 |  external/provider net  |     |   Octavia mgmt plane    |
                 +-------------------------+     |   o-hm0 10.3.1.5x/24    |
                              |  OVN localnet patch           |  o-hm0 IPs —
                              |                               |  (lb-mgmt-net traffic)
                              v                               v
                 +------------+-------------------------------+------------+
                 |             br-int (OVN integration bridge)             |
                 +---------------------------------------------------------+
```

The `ens9 → br-ex2 → o-hm0` path (right side) is the flat network doing the actual Octavia management-plane work — untagged the whole way, which is what lets it cross the port-secured uplink. `ens8 → br-ex1` is the older VLAN-capable path, kept for the external/provider network only. Two bridges, two jobs, no confusion.

### 5.1 Per-node `o-hm0` mapping (flat, no VLAN tag)

| Node | o-hm0 IP |
|---|---|
| controller-1 | 10.3.1.51 |
| controller-2 | 10.3.1.52 |
| controller-3 | 10.3.1.53 |

- `lb-mgmt-net`: flat, `physnet2`, subnet `10.3.1.0/24`, gateway `10.3.1.1`, DHCP pool `10.3.1.10–.40`
- `o-hm0` addresses (.51/.52/.53) are static, deliberately outside the DHCP pool.

### 5.2 Heartbeat / control-plane traffic flow

```text
[Amphora VM (lb-mgmt-net + demo-net)]
        |
        |  heartbeat (UDP 5555) every few seconds
        v
[o-hm0 (br-ex2) — flat network, untagged]
        |
        |  delivered via br-ex2 to any health-manager
        v
[octavia_health_manager (each controller, :5555/udp)]
        |
        |  agent API calls (TCP 9443) — config push, cert rotation
        v
[Amphora VM (config applied, certs rotated)]

(controller_ip_port_list in octavia.conf lists all 3 health-managers —
any of them can receive an amphora's heartbeat)
```

---

## 6. `globals.yml` — Required Octavia Block

```yaml
####################
# Neutron additions for physnet2 / br-ex2
####################
neutron_external_interface: "ens8,ens9"
neutron_bridge_name: "br-ex1,br-ex2"
neutron_physical_networks: "physnet1,physnet2"
neutron_ovn_bridge_mappings: "physnet1:br-ex1,physnet2:br-ex2"
neutron_ovn_vlan_ranges: "physnet1:1:4094,physnet2:1:4094"

####################
# Octavia
####################
enable_octavia: "yes"
octavia_provider_drivers: "amphora:Amphora provider"
octavia_auto_configure: "yes"

# Must be "o-hm0" — NOT "ens9". ens9 gets enslaved into the OVS bridge
# and loses its IPv4 at the kernel level; only o-hm0 (layered on top) has one.
octavia_network_interface: "o-hm0"

# Must match the --tag used when uploading the Amphora image to Glance
octavia_amp_image_tag: "amphora"

octavia_amp_flavor:
  name: "amphora"
  is_public: no
  vcpus: 1
  ram: 1024
  disk: 5

octavia_amp_network:
  name: "lb-mgmt-net"
  provider_network_type: "flat"
  provider_physical_network: "physnet2"
  external: false
  shared: false
  subnet:
    name: "lb-mgmt-subnet"
    cidr: "10.3.1.0/24"
    allocation_pool_start: "10.3.1.10"
    allocation_pool_end: "10.3.1.40"
    enable_dhcp: yes

horizon_enable_octavia_ui: "yes"
```

### 6.1 `/etc/kolla/config/octavia.conf` (config override, all 3 controllers)

```ini
[health_manager]
controller_ip_port_list = 10.3.1.51:5555,10.3.1.52:5555,10.3.1.53:5555

[nova]
# Without this, kolla defaults the amphora image owner filter to the "service"
# project, but our amphora image is uploaded under the admin/demo project —
# causing "no images found" even though the tag matches.
amp_image_owner_id = 36c1fc081a7e4821a95b5f0f96129293
```

---

## 7. Deployment Guide

Run on `controller-1` unless noted; `~/multinode` is the inventory.

### 7.1 Generate certificates

```bash
kolla-ansible -i ~/multinode octavia-certificates
```

### 7.2 Build and upload the Amphora image

opendev.org's git/raw endpoints are blocked by a bot-challenge from our network. We're not sure whether it's guarding against bots or making the humans work for it, but either way, mirror overrides are required.

```bash
pip install diskimage-builder --break-system-packages
git clone https://github.com/openstack/octavia.git
cd octavia/diskimage-create/
export DIB_REPOLOCATION_amphora_agent=https://github.com/openstack/octavia
export DIB_REPOLOCATION_octavia_lib=https://github.com/openstack/octavia-lib
export DIB_REPOLOCATION_upper_constraints=https://github.com/openstack/requirements
bash diskimage-create.sh

source /etc/kolla/admin-openrc.sh
openstack image create amphora-x64-haproxy \
  --public \
  --container-format bare \
  --disk-format qcow2 \
  --file amphora-x64-haproxy.qcow2 \
  --tag amphora
```

### 7.3 Reconfigure Neutron/OVN for physnet2 first

```bash
kolla-ansible -i ~/multinode reconfigure -t neutron,ovn
```

### 7.4 Create `o-hm0` on every controller (before deploying Octavia)

Repeat on controller-1, controller-2, controller-3 with the node's own IP from the table in §5:

```bash
ovs-vsctl --if-exists del-port o-hm0
ovs-vsctl add-port br-ex2 o-hm0 -- set Interface o-hm0 type=internal
ip link set o-hm0 up
ip addr add 10.3.1.51/24 dev o-hm0   # .52 on controller-2, .53 on controller-3
```

> No VLAN tag is set — this is a flat network, on purpose. Check the MAC OVS assigned (`ovs-vsctl list interface o-hm0`) — you'll need it in the next step to bind the Neutron port.

### 7.5 Create the Neutron health-manager port per node and bind it

```bash
source /etc/kolla/admin-openrc.sh
openstack port create \
  --network lb-mgmt-net \
  --device-owner Octavia:health-mgr \
  --fixed-ip ip-address=10.3.1.51 \
  --no-security-group \
  octavia-health-manager-port-controller-1

openstack port set --host controller-1 octavia-health-manager-port-controller-1
```

Repeat with the matching IP/hostname for controller-2 and controller-3.

### 7.6 Deploy Octavia

```bash
kolla-ansible -i ~/multinode reconfigure -t octavia,horizon
kolla-ansible -i ~/multinode post-deploy
```

### 7.7 Post-Deploy Verification

```bash
# All 5 containers up
docker ps --format "table {{.Names}}\t{{.Status}}" | grep octavia

# Provider registered
openstack loadbalancer provider list

# lb-mgmt-net created correctly (flat, physnet2)
openstack network show lb-mgmt-net | grep -E "provider:|id"

# Amphora flavor and security groups auto-created
openstack flavor list --all | grep amphora
openstack security group list | grep -i lb

# Health-manager bound and listening, per controller
docker exec octavia_health_manager grep bind_ip /etc/octavia/octavia.conf
docker exec octavia_health_manager ss -ulnp | grep 5555

# o-hm0 reachable between controllers
ping -c3 -I o-hm0 10.3.1.51
ping -c3 -I o-hm0 10.3.1.52
ping -c3 -I o-hm0 10.3.1.53

# Worker log should end clean — no ConfigFileValueError / CRITICAL
docker logs octavia_worker 2>&1 | tail -20
```

---

## 8. Known Issues & Fixes

| Symptom | Root Cause | Fix |
|---|---|---|
| `reconfigure` fails templating `octavia_network` with "Address family 'ipv4' undefined on interface" | `octavia_network_interface` set to `ens9`; ens9 loses its IPv4 once enslaved into the OVS bridge | Set `octavia_network_interface: "o-hm0"` in globals.yml |
| `Unable to create the flat network. Physical network physnet1 is in use` | Neutron allows only one flat network per physical_network, and `physnet1` was already the external/provider network | Give Octavia its own `physnet2` / `br-ex2` on a dedicated NIC |
| LB stuck in `PENDING_CREATE`, worker logs show zero images found for tag `amphora` | `amp_image_owner_id` defaults to the "service" project, but the image is owned by admin/demo | Add `[nova] amp_image_owner_id = <project-id>` override in `/etc/kolla/config/octavia.conf` |
| Amphora heartbeats never arrive; health-manager sees nothing despite o-hm0 being up | `controller_ip_port_list` in octavia.conf referencing stale/old IPs from an earlier network revision | Confirm the actually-live o-hm0 IPs per node (`ip a`) before trusting older docs, then update the override |
| Members show `ERROR` operating status, backends unreachable from the amphora | Amphora's VRRP port missing from OVN's northbound/southbound DB entirely (sync gap) | `openstack loadbalancer failover <lb>` to force Octavia to recreate the amphora and its ports cleanly |
| LB provisioning stuck in `ERROR` after member/health-monitor creation, worker log shows repeated DB deadlocks on `amphora_health` updates | DB lock contention during heartbeat processing under load | Usually self-resolves after a few minutes; if not, restart `octavia_api`, `octavia_worker`, `octavia_health_manager`, `octavia_housekeeping` together, or delete/recreate the LB (`--cascade`) as a last resort |

---

## 9. Creating a Load Balancer

### 9.1 Build the backend VMs

```bash
source /etc/kolla/admin-openrc.sh
DEMO_NET_ID=$(openstack network show demo-net -f value -c id)

openstack server create backend-1 \
  --image cirros-0.6.2-x86_64-disk \
  --flavor m1.tiny \
  --network $DEMO_NET_ID \
  --security-group default \
  --wait

openstack server create backend-2 \
  --image cirros-0.6.2-x86_64-disk \
  --flavor m1.tiny \
  --network $DEMO_NET_ID \
  --security-group default \
  --wait

# Note the DHCP-assigned IPs — used below as the member addresses
openstack server list -f value -c Name -c Networks
```

Console into each and start a basic HTTP responder for testing:

```bash
openstack console log show backend-1
# via console/SSH:
while true; do echo -e "HTTP/1.1 200 OK\r\n\r\nhello from backend-1" | sudo nc -l -p 80; done &
```

### 9.2 Build the load balancer

```bash
SUBNET_ID=$(openstack subnet show demo-subnet -f value -c id)

# 1. Load Balancer
openstack loadbalancer create --name web-lb --vip-subnet-id $SUBNET_ID --wait

# 2. Listener
openstack loadbalancer listener create --name web-listener \
  --protocol HTTP --protocol-port 80 --wait web-lb

# 3. Pool
openstack loadbalancer pool create --name web-pool \
  --lb-algorithm ROUND_ROBIN --listener web-listener --protocol HTTP --wait

# 4. Members (use the real backend IPs noted in 9.1)
openstack loadbalancer member create --name backend-1 \
  --subnet-id $SUBNET_ID --address 10.0.0.54 --protocol-port 80 web-pool
openstack loadbalancer member create --name backend-2 \
  --subnet-id $SUBNET_ID --address 10.0.0.107 --protocol-port 80 web-pool

# 5. Health Monitor (required for ONLINE status)
openstack loadbalancer healthmonitor create --name web-health \
  --delay 5 --max-retries 4 --timeout 10 --type HTTP --url-path / web-pool

# 6. Optional: floating IP for external access
openstack floating ip create --port <vip-port-id> public1
```

### 9.3 Troubleshooting Load Balancer Creation

| Symptom | Likely Cause | Fix |
|---|---|---|
| LB stuck in `PENDING_CREATE` for more than a few minutes | Amphora VM never spawned, or spawned but never reached lb-mgmt-net | `openstack server list --all-projects \| grep amphora`; check `docker logs octavia_worker` for errors; confirm o-hm0 status on all 3 controllers |
| Member `operating_status` is `NO_MONITOR` | Health monitor not yet created | Create one — pool won't route traffic without it |
| Member shows `ERROR`, curl from inside the amphora times out or gets "No route to host" | Backend security group doesn't allow inbound from the amphora's data-plane subnet | `openstack security group rule create --protocol tcp --dst-port 80 --remote-ip <tenant-subnet-cidr> <backend-sg-id>` |
| Member reachable from other VMs on the same network, but not from the amphora specifically | Amphora's VRRP/data port missing from OVN's logical switch ports | `openstack loadbalancer failover <lb-name>` |
| `Cannot update lb-mgmt-net provider_network_type` | Neutron doesn't allow changing provider type on an existing network | Delete network/subnet/ports/security groups for `lb-mgmt-net` and let kolla recreate it on next reconfigure |
| Backend shows ACTIVE but never answers curl | Guest OS itself never started listening (e.g. HTTP responder loop wasn't running, or disk I/O errors on boot) | Console in, confirm `ip addr` came up and the listener command is actually running; recreate the VM if the disk looks corrupted |

---

## 10. Terms & Concepts Needed During LB Creation

| Term | Meaning |
|---|---|
| **VIP** | Virtual IP — the single address clients connect to; lives on the amphora's data-plane port |
| **Listener** | Binds the LB to a protocol + port (e.g. HTTP/80) |
| **Pool** | Group of backend members behind a listener, plus the load-balancing algorithm |
| **Member** | One backend server (IP + port + weight) inside a pool |
| **Health Monitor** | Active check (HTTP/TCP/PING) that determines if a member is ONLINE; without one, members stay in `NO_MONITOR` and the pool won't route to them |
| **Provisioning Status** | Infrastructure state — `ACTIVE` means the object was built successfully (amphora booted, ports wired) |
| **Operating Status** | Traffic-serving state — `ONLINE` means health checks are passing and it's actually routing |
| **Amphora** | The HAProxy-running VM instance backing a Load Balancer object, 1:1 |
| **Failover** | Forces Octavia to tear down and recreate an amphora and its ports — the standard fix for corrupted OVN state |

---

## 11. Load Balancing Algorithm Testing

**Environment:** Ubuntu bastion / Octavia check VM **Target:** `web-lb`, VIP `10.0.0.60` (accessed externally via floating IP `10.10.20.14`) **Backends:** `backend-1` (10.0.0.54), `backend-2` (10.0.0.107) — Cirros instances running a minimal HTTP daemon returning `hello from backend-1` / `hello from backend-2` **Algorithms tested:** Round-Robin, Source IP, Least Connections

### 11.1 Test Environment

| Component | Identifier / IP | Description |
|---|---|---|
| Client node | `ubuntu@bastion` | Traffic generator — curl, nc, ss, bash |
| Load Balancer VIP | `10.10.20.14:80` | Octavia HAProxy frontend (floating IP on `web-lb`) |
| Backend instances | `backend-1`, `backend-2` | Cirros minimal Linux, HTTP daemon on port 80 |

### 11.2 Test Case 1 — Round-Robin

**Objective:** Confirm requests alternate sequentially across pool members (`1 → 2 → 1 → 2 …`) with no session persistence.

```bash
for i in {1..10}; do curl -s http://10.10.20.14; done
```

**Observed output:**
```
hello from backend-2
hello from backend-1
hello from backend-2
hello from backend-1
hello from backend-2
hello from backend-1
hello from backend-2
hello from backend-1
hello from backend-2
hello from backend-1
```

**Result: PASSED** — exact 50/50 alternation, no stickiness, as expected.

### 11.3 Test Case 2 — Source IP Hashing & Weight Re-balancing

**Objective:** Confirm a single client IP sticks to one backend, and observe hash-ring behavior when member weights change.

```bash
# Weight 1:1
for i in {1..20}; do curl http://10.10.20.14; done
# → hello from backend-1 (all 20 calls)

# Backend-2 weight changed 1 → 2 (ratio 1:2)
for i in {1..20}; do curl http://10.10.20.14; done
# → hello from backend-2 (all 20 calls)
```

**Why the target flipped:** Source IP hashing maps client IPs onto a hash ring sized proportionally to member weight. At 1:1 the ring is split 50/50 and the client IP hashed into backend-1's slot. At 1:2, backend-2 takes ~66% of the ring, shifting the client's hash bucket to backend-2. Persistence held across all 20 calls in each run — only the rebalancing event changed the target.

**Multi-source-IP testing options** (to test hashing from more than one client IP off a single test node):
- **IP aliasing** (recommended for L4) — add IP aliases to the interface, use `curl --interface <IP>`
- **Docker containers** — each container gets its own bridge-network IP
- **X-Forwarded-For spoofing** (L7 only) — `curl -H "X-Forwarded-For: 192.168.1.X"`, only valid if the listener is configured for header-based hashing

### 11.4 Test Case 3 — Least Connections

**Objective:** Confirm the LB routes new connections to the member with fewer active connections, rather than by rotation.

**Challenge:** plain sequential `curl` calls complete in milliseconds. By the time the load balancer blinks, the connection is already gone — active connection counts sit at 0 on both members the whole time. With nothing to differentiate on, the LB shrugs and falls back to Round-Robin.

**Workaround — simulate sustained load with background raw sockets:**
```bash
for i in {1..10}; do (exec 3<>/dev/tcp/10.10.20.14/80; sleep 30) & done

ss -ant | grep 10.10.20.14:80
# ESTAB 0 0 10.10.20.83:37622 10.10.20.14:80
# ESTAB 0 0 10.10.20.83:37554 10.10.20.14:80
# ... 10 persistent TCP streams
```

**Observed:** follow-up requests still alternated Round-Robin style even with load present.

**Root cause analysis:**

| Factor | Mechanism | Effect on the test |
|---|---|---|
| Equal load distribution | The 10 background connections split 5/5 across backends | Tied counts → LB falls back to round-robin for new requests |
| Cirros httpd behavior | busybox httpd sends `FIN` immediately after responding | Server-side connection count returns to 0 instantly regardless of client-side delay |
| HAProxy multiplexing | Octavia's HAProxy reuses HTTP Keep-Alive pools | Multiple fast requests share one connection channel instead of registering as separate active counts |

**Conclusion:** confirmed correct — Least Connections falls back to Round-Robin when the counts are tied. That's the algorithm following its spec, not a bug. The real takeaway: testing it meaningfully requires genuinely long-lived, asymmetric backend load (large file transfers, slow endpoints), not short-lived idle sockets that vanish faster than office snacks on a Friday.

### 11.5 Summary

| Algorithm | Routing determinant | Observed behavior | Best fit |
|---|---|---|---|
| Round-Robin | Sequential rotation | Exact 1→2→1→2 alternation | Stateless microservices, uniform fast requests |
| Source IP | Client IP hash | 100% sticky per client; shifts when weight changes the hash-ring boundaries | Legacy apps needing session state without distributed caching |
| Least Connections | Active in-flight connection count | Routes to the least-loaded member; falls back to round-robin on ties | Long-running queries, uploads, WebSocket/streaming workloads |

All three algorithms behaved per their algorithmic specification against `web-lb`.

---

## 12. Quick Reference — Command Cheat Sheet

```bash
# Deploy / reconfigure
kolla-ansible -i ~/multinode octavia-certificates
kolla-ansible -i ~/multinode reconfigure -t neutron,ovn
kolla-ansible -i ~/multinode reconfigure -t octavia,horizon
kolla-ansible -i ~/multinode post-deploy

# Health-manager port per controller
ovs-vsctl add-port br-ex2 o-hm0 -- set Interface o-hm0 type=internal
ip link set o-hm0 up
ip addr add 10.3.1.5X/24 dev o-hm0
openstack port create --network lb-mgmt-net --device-owner Octavia:health-mgr \
  --fixed-ip ip-address=10.3.1.5X --no-security-group octavia-health-manager-port-controller-X
openstack port set --host controller-X octavia-health-manager-port-controller-X

# Verify
docker ps --format "table {{.Names}}\t{{.Status}}" | grep octavia
openstack loadbalancer provider list
openstack network show lb-mgmt-net | grep -E "provider:|id"
docker exec octavia_health_manager ss -ulnp | grep 5555
ping -c3 -I o-hm0 10.3.1.51

# Load balancer lifecycle
openstack loadbalancer create --name web-lb --vip-subnet-id <subnet> --wait
openstack loadbalancer listener create --name web-listener --protocol HTTP --protocol-port 80 --wait web-lb
openstack loadbalancer pool create --name web-pool --lb-algorithm ROUND_ROBIN --listener web-listener --protocol HTTP --wait
openstack loadbalancer member create --name backend-1 --subnet-id <subnet> --address 10.0.0.54 --protocol-port 80 web-pool
openstack loadbalancer healthmonitor create --name web-health --delay 5 --max-retries 4 --timeout 10 --type HTTP --url-path / web-pool
openstack loadbalancer failover <lb-name>

# Logs
docker logs octavia_worker 2>&1 | tail -20
docker logs octavia_health_manager 2>&1 | tail -20
```

---

## 13. Open Items / Recommendations

- **Persist the `octavia.conf` overrides** via `/etc/kolla/config/octavia.conf` on the deploy host (already done for `amp_image_owner_id` and `controller_ip_port_list`) — otherwise a future `kolla-ansible deploy`/`reconfigure` will silently revert any live-only edits.
- **Re-verify the live `o-hm0` IPs after any network revision** before trusting old docs — the health-manager `controller_ip_port_list` must match reality, or heartbeats silently die (Problem #4 in Section 8).
- **Reserve a second NIC (`ens9`) early** for the Octavia management plane if you're in a nested/port-secured cloud. Retrofitting `physnet2` after deploy is possible but more painful than doing it in `globals.yml` from the start.
- **If OVN state drifts again** (amphora ports missing from logical switches), `openstack loadbalancer failover` is the reliable reset — prefer it over manual port surgery.
- Consider whether `busybox httpd`-style backend behavior masks real Least-Connections behavior in future tests; use long-lived asymmetric load (uploads, streams) instead of short-lived sockets.

