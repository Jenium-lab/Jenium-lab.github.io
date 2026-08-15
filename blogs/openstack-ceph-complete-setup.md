# OpenStack + Ceph Complete Setup — Kolla-Ansible 2025.1 with a Ceph Reef Backend

**Environment:** Kolla-Ansible (stable/2025.1, Ubuntu), Ceph Reef managed via `cephadm`, running as a nested cloud inside an outer OpenStack deployment (the outer cloud provides NICs and provider networks). **Cluster:** 3 controllers (`controller{1..3}-vps.rts`) as Ceph MONs + OpenStack control/network/monitoring; 2 computes (`compute{1..2}-vps.rts`) as Ceph OSDs + OpenStack compute/storage. Deployer is the bastion host (`localhost`, passwordless SSH to all nodes). **Storage:** Ceph MON at `10.88.10.80` (public network), cluster network `192.168.20.0/24`, pools `volumes` / `images` / `backups` / `vms`, replication factor 2 spread across hosts (`replicated_osd_new` CRUSH rule). Timezone everywhere: `Asia/Kathmandu`.

---

## 1. Introduction

Every cloud is really two stories braided into one. Up front, you've got OpenStack — the host with the clipboard, signing guests in, shuffling VMs around, deciding who gets a room. Behind the scenes, out of sight, is Ceph — the basement kitchen and wine cellar where every disk actually lives.

You can build OpenStack on plain local disks. It'll even run, for a while. Then the moment a VM needs to migrate, or a compute node dies, or a volume has to be somewhere other than the one disk it was written on, you'll wish you'd built the basement first. Ceph is that basement: distributed, self-healing, replicated across *hosts* so no single machine's death takes your data with it.

This guide is the full tour, start to finish: **Ceph first, OpenStack second**, wired together with keyrings and config files. We deployed this exact stack on a nested cloud (a smaller OpenStack running inside a bigger one), and every command below survived contact with reality.

> **House rules.** The deployer node must reach every other node over passwordless SSH — no exceptions. If you skip that, Ceph and Kolla will both stop mid-act and look at you expectantly.

---

## 2. Environment (Cast & Stage)

Full disclosure before the curtain rises: this cluster runs as VMs inside an outer OpenStack cloud. The outer cloud provides our NICs and provider networks, which shapes a few networking decisions below (nested clouds get nested opinions).

### 2.1 Node roles

| Node | Role in Ceph | Role in OpenStack | Purpose |
|---|---|---|---|
| `controller1-vps.rts` | MON + deployer | control · network · monitoring | First Ceph node, bootstraps everything |
| `controller2-vps.rts` | MON | control · network · monitoring | Quorum, HA, API haproxy |
| `controller3-vps.rts` | MON | control · network · monitoring | Quorum, HA, API haproxy |
| `compute1-vps.rts` | OSD | compute · storage | Runs your VMs, holds your data |
| `compute2-vps.rts` | OSD | compute · storage | Runs your VMs, holds your data |

### 2.2 Networks

| Network | Subnet | Who uses it |
|---|---|---|
| Ceph public network | `10.88.10.0/24` (mon at `10.88.10.80`) | Ceph clients talk to MONs |
| Ceph cluster network | `192.168.20.0/24` | OSDs gossip & replicate — keep it private |
| Management / API | `192.168.10.x` | OpenStack control plane |
| External / provider | `10.10.20.x` | Public-facing networks |

The topology is almost poetic: management traffic in one world, storage gossip in another, and the external world at the door.

```text
            +------+------------+------------+------------+------------+------+
            |                  Deployer / Bastion (localhost)                 |
            |                        ansible + cephadm                        |
            |                  passwordless SSH to every node                 |
            +------+------------+------------+------------+------------+------+
                   |            |            |            |            |
                   v            v            v            v            v
              +---------+  +---------+  +---------+  +---------+  +---------+
              | ctrl-1  |  | ctrl-2  |  | ctrl-3  |  | comp-1  |  | comp-2  |
              |   MON   |  |   MON   |  |   MON   |  |   OSD   |  |   OSD   |
              | + Nova  |  | + Nova  |  | + Nova  |  | + Nova  |  | + Nova  |
              +---------+  +---------+  +---------+  +---------+  +---------+
                   |            |            |            |            |
                   +-------------------------+            +------------+
                           MON quorum                    cluster network
                        (controllers 1-3)               (192.168.20.0/24)
```

---

## 3. Phase 1 — Ceph: Building the Storage Backend

A storage cluster is a society of small duties. Nobody works alone; everyone talks to everyone; and if a member drops off the grid, its workload is redistributed before the drinks even get warm. Here's how we summon that society.

### 3.1 Set the clocks — every node, same time

Distributed systems are petty about time. If one node is living an hour in the future, its replicas file complaints. Fix it everywhere first:

```bash
for node in controller{1..3}-vps.rts compute{1..2}-vps.rts
do
  echo "=== Setting timezone on $node ==="
  ssh root@$node timedatectl set-timezone Asia/Kathmandu
  sleep 2
done
```

### 3.2 Install Docker from the real repo

Cephadm's whole job is running Ceph inside containers, so the containers need a babysitter.

```bash
apt-get install apt-transport-https ca-certificates curl gnupg-agent software-properties-common -y
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor > /etc/apt/trusted.gpg.d/docker-ce.gpg
echo "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -sc) stable" > /etc/apt/sources.list.d/docker-ce.list
apt-get update; apt-get install docker-ce docker-ce-cli containerd.io -y
systemctl enable --now docker
```

### 3.3 Install cephadm

```bash
wget -q -O- 'https://download.ceph.com/keys/release.asc' | gpg --dearmor -o /etc/apt/trusted.gpg.d/cephadm.gpg
echo deb https://download.ceph.com/debian-reef/ $(lsb_release -sc) main > /etc/apt/sources.list.d/cephadm.list
apt-get update
apt-cache policy cephadm; apt-get install cephadm -y
```

### 3.4 Bootstrap — light the first candle

One node must come first. It becomes the primordial MON, and everything else joins it.

```bash
cephadm bootstrap --mon-ip=10.88.10.80 \
  --cluster-network 192.168.20.0/24 \
  --initial-dashboard-password=startsm \
  --dashboard-password-noupdate \
  --allow-fqdn-hostname | tee cephadm-bootstrap.log
```

The `--cluster-network` is the private gossip line (`192.168.20.0/24`) — replication traffic rides that lane so it never fights API traffic for bandwidth.

### 3.5 Install ceph-common (the client tooling)

The other nodes need to speak Ceph:

```bash
/usr/sbin/cephadm shell --fsid <fsid_id> -c /etc/ceph/ceph.conf -k /etc/ceph/ceph.client.admin.keyring
cephadm install ceph-common
```

### 3.6 Spread the SSH keys — the passwordless handshake

Ceph orchestrates every host by SSH. Introduce it to all of them, key by key:

```bash
for node in controller{1..3}-vps.rts compute{1..2}-vps.rts
do
  echo "=== Copying ceph.pub to $node ==="
  ssh-copy-id -f -i /etc/ceph/ceph.pub root@$node
  sleep 2
done
```

### 3.7 Admit the hosts to the cluster

```bash
for node in controller{2..3}-vps.rts compute{1..2}-vps.rts
do
  ceph orch host add $node
done
```

### 3.8 Label the MONs and apply a MON service

Labels are how we tell the orchestrator *who does what*. Mark the three controllers as MONs, then declare the MON service with a manifest — three copies, one per label match:

```bash
for node in controller{1..3}-vps.rts
do
  ceph orch host label add $node mon
done
```

`mon_service.yml`:
```yaml
service_type: mon
service_name: mon
placement:
  label: "mon"
  count: 3
```

Apply it:

```bash
ceph orch apply -i mon_service.yml
```

Three MONs, one quorum, no single point of failure.

### 3.9 Label the OSDs — the workers

```bash
for node in compute{1..2}-vps.rts
do
  ceph orch host label add $node osd
done
```

### 3.10 Add the OSDs — the hard part

First, look at what the orchestrator sees:

```bash
ceph orch device ls
```

New disks often carry ghost data from a previous life. Purge them:

```bash
# from the deployer node
ceph orch device zap <fqdn_osd_server> /dev/sdb --force

# still stubborn? walk into the node and scrub by hand
wipefs -a /dev/sdX
dd if=/dev/zero of=/dev/sdc bs=1M count=100 status=progress
```

Then hand the cleaned disk to Ceph:

```bash
ceph orch daemon add osd compute1:/dev/sdb
```

> **Note:** the original notes read `compute1:/dev/command` — that is, of course, a typo for `compute1:/dev/sdX`. An OSD cannot be a *command*; it is a loyal servant of one disk.

### 3.11 Create the pools — shelves in the basement

OpenStack will need named shelves. Create them now; they're cheap to make, annoying to rename:

```bash
for pool_name in volumes images backups vms
do
  ceph osd pool create $pool_name
  rbd pool init $pool_name
done
```

### 3.12 Replication — two copies, on two *different* hosts

A replication factor of 2 means data lives twice. But if both copies sit on the same machine, that's reassurance, not safety. The CRUSH rule must scatter copies across *hosts*, not disks:

```bash
ceph osd pool set .mgr     size 2
ceph osd pool set volumes  size 2
ceph osd pool set images   size 2
ceph osd pool set backups  size 2
ceph osd pool set vms      size 2

ceph osd crush rule create-replicated replicated_osd_new default host
ceph osd pool set .mgr     crush_rule replicated_osd_new
ceph osd pool set volumes  crush_rule replicated_osd_new
ceph osd pool set images   crush_rule replicated_osd_new
ceph osd pool set backups  crush_rule replicated_osd_new
ceph osd pool set vms      crush_rule replicated_osd_new

# verify
ceph osd crush rule dump replicated_osd_new
ceph osd pool get vms crush_rule
```

The basement is open. Time to staff the front of house.

---

## 4. Phase 2 — OpenStack Kolla-Ansible: The Hotel on Top

OpenStack is the grand hotel. Nova is the concierge that places guests (VMs). Glance is the photo album of boot images. Cinder is the luggage room. And like any hotel, it needs its own identity cards to access the basement.

### 4.1 Mint the Ceph keyrings — the staff badges

Each OpenStack service gets a keyring granting exactly the access it needs — least privilege, the old-fashioned way:

```bash
ceph auth get-or-create client.glance mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=images' \
  -o /etc/ceph/ceph.client.glance.keyring

ceph auth get-or-create client.cinder mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=volumes, allow rwx pool=images' \
  -o /etc/ceph/ceph.client.cinder.keyring

ceph auth get-or-create client.nova mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=vms, allow rx pool=images' \
  -o /etc/ceph/ceph.client.nova.keyring

ceph auth get-or-create client.cinder-backup mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=backups' \
  -o /etc/ceph/ceph.client.cinder-backup.keyring
```

Notice the pattern — each service can read what it needs, write only to its own pools. Glance reads and writes `images`; Nova manages `vms` but only *reads* `images`; Cinder owns `volumes`. Nobody wanders into rooms they don't need.

### 4.2 Prepare the deployer — a clean room on the bastion

```bash
apt install python3-venv
mkdir /root/py
python3 -m venv /root/py
source /root/py/bin/activate
```

### 4.3 Install dependencies

```bash
pip install -U pip
pip install 'ansible-core>=2.17,<2.19'
pip install docker
apt install libdbus-1-dev pkg-config cmake libglib2.0-dev python3-dev
```

### 4.4 Pull Kolla-Ansible (stable/2025.1)

```bash
pip install git+https://opendev.org/openstack/kolla-ansible@stable/2025.1
```

### 4.5 Lay out the configuration directories

```bash
mkdir -p /etc/kolla
chown root:root /etc/kolla
cp -r /root/py/share/kolla-ansible/etc_examples/kolla/* /etc/kolla
cp /root/py/share/kolla-ansible/ansible/inventory/multinode /root
```

### 4.6 Finish the deployer tooling

```bash
kolla-ansible install-deps
pip install dbus-python
```

### 4.7 Generate passwords — the master keychain

```bash
kolla-genpwd
```

This writes the whole hotel's keychain to `/etc/kolla/passwords.yml`. Guard it like the crown jewels; every service credential lives in that one file.

### 4.8 Ansible, behave yourself

```bash
mkdir /etc/ansible
tee /etc/ansible/ansible.cfg<<EOF
[defaults]
host_key_checking=False
pipelining=True
forks=100
EOF
```

### 4.9 The inventory — who's on the dance floor

Edit `multinode`:

```ini
[control]
controller1-vps.rts
controller2-vps.rts
controller3-vps.rts

[network]
controller1-vps.rts
controller2-vps.rts
controller3-vps.rts

[compute]
compute1-vps.rts
compute2-vps.rts

[monitoring]
controller1-vps.rts
controller2-vps.rts
controller3-vps.rts

[storage]
compute1-vps.rts
compute2-vps.rts

[deployment]
localhost       ansible_connection=local
```

Three hats each on the controllers — control, network, and monitoring. The computes wear two: compute and storage, because your OSDs *are* your compute nodes. The machines that run your VMs are the same machines that hold your data.

### 4.10 Sign the certificates

```bash
kolla-ansible certificates -i multinode
```

### 4.11 The secret handshake — Ceph configs into Kolla

Now the hotel learns the basement's address. Build the config tree and smuggle in `ceph.conf` plus the keyrings:

```bash
mkdir /etc/kolla/config
mkdir /etc/kolla/config/nova
mkdir /etc/kolla/config/glance
mkdir -p /etc/kolla/config/cinder/cinder-volume
mkdir -p /etc/kolla/config/cinder/cinder-backup

# IMPORTANT: remove any tab characters from /etc/ceph.conf first!
cp /etc/ceph/ceph.conf /etc/kolla/config/cinder/
cp /etc/ceph/ceph.conf /etc/kolla/config/nova/
cp /etc/ceph/ceph.conf /etc/kolla/config/glance/

cp /etc/ceph/ceph.client.glance.keyring /etc/kolla/config/glance/
cp /etc/ceph/ceph.client.nova.keyring   /etc/kolla/config/nova/
cp /etc/ceph/ceph.client.cinder.keyring /etc/kolla/config/nova/
cp /etc/ceph/ceph.client.cinder.keyring /etc/kolla/config/cinder/cinder-volume/
cp /etc/ceph/ceph.client.cinder.keyring /etc/kolla/config/cinder/cinder-backup/
cp /etc/ceph/ceph.client.cinder-backup.keyring /etc/kolla/config/cinder/cinder-backup/
```

And because *every* node may need to talk to Ceph, push the whole `/etc/ceph` directory out:

```bash
for node in controller{2..3}-vps.rts compute{1..2}-vps.rts
do
  scp -r /etc/ceph/ root@$node:/etc/
done
```

> **A hard-won warning:** tabs in `ceph.conf` will break config parsing inside the containers in ways that produce zero useful error messages. Strip them before you copy. Trust us.

### 4.12 Tune `/etc/kolla/globals.yml`

This is where the hotel's personality lives — the VIP, the backend (Ceph via RBD), the network backends, the interface names. Give it the real values for your environment:

- `kolla_internal_vip_address` / VIP on your management network
- `network_interface`, `neutron_external_interface`, `tunnel_interface`
- `enable_ceph: "no"` for Ceph-as-internal-service — you're bringing your own basement
- Storage backends for Glance/Cinder/Nova pointed at RBD and the `vms` pool

### 4.13 Deploy — the moment of truth

**a. Bootstrap the servers** (install Docker, prepare disks, lay the foundation):

```bash
kolla-ansible bootstrap-servers -i multinode
```

**b. Prechecks** (let it complain now, in a good way):

```bash
kolla-ansible prechecks -i multinode
```

**c. Deploy** (for full confession mode, add `-vvv`):

```bash
kolla-ansible deploy -i multinode
```

This is the long one. Go make tea. Watch the container fleet wake up, one service at a time, like a hotel's staff arriving for the morning shift.

### 4.14 Post-deploy — open the doors

```bash
kolla-ansible post-deploy -i multinode
# Optional — the classic but occasionally moody init script:
./init-runonce
```

Trust the freshly minted CA so TLS stops complaining:

```bash
cat /etc/kolla/certificates/ca/root.crt | sudo tee -a /etc/ssl/certs/ca-certificates.crt
echo "export OS_CACERT=/etc/ssl/certs/ca-certificates.crt" >> /etc/kolla/admin-openrc.sh
```

---

## 5. Quick Reference — Command Cheat Sheet

```bash
# Ceph
ceph orch host label add <host> mon
ceph orch host label add <host> osd
ceph orch apply -i mon_service.yml
ceph orch device ls
ceph orch device zap <fqdn_osd_server> /dev/sdX --force
ceph orch daemon add osd compute1:/dev/sdX
ceph osd pool create <volumes|images|backups|vms> && rbd pool init <pool>
ceph osd pool set <pool> size 2
ceph osd crush rule create-replicated replicated_osd_new default host
ceph osd pool set <pool> crush_rule replicated_osd_new
ceph osd crush rule dump replicated_osd_new

# Ceph keyrings for OpenStack services
ceph auth get-or-create client.glance mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=images'
ceph auth get-or-create client.cinder mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=volumes, allow rwx pool=images'
ceph auth get-or-create client.nova mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=vms, allow rx pool=images'
ceph auth get-or-create client.cinder-backup mon 'allow r' \
  osd 'allow class-read object_prefix rbd_children, allow rwx pool=backups'

# Kolla-Ansible deploy
kolla-ansible bootstrap-servers -i multinode
kolla-ansible prechecks -i multinode
kolla-ansible deploy -i multinode        # add -vvv for verbose
kolla-ansible post-deploy -i multinode

# Post-deploy TLS trust
cat /etc/kolla/certificates/ca/root.crt | sudo tee -a /etc/ssl/certs/ca-certificates.crt
echo "export OS_CACERT=/etc/ssl/certs/ca-certificates.crt" >> /etc/kolla/admin-openrc.sh
```

---

## 6. Open Items / Recommendations

- **Persist Ceph config changes via the deployer.** Any future `ceph orch` change should be mirrored from the bootstrap node (`controller1-vps.rts`), not improvised ad-hoc on workers — the orchestrator treats the bootstrap node's `/etc/ceph` as source of truth.
- **Audit keyring scope after upgrades.** If you bump Kolla releases later, re-check that `nova` still only needs `rx` on `images` and `cinder-backup` still owns only `backups` — drift here silently broadens privilege or breaks backups.
- **Keep the `passwords.yml` safe and backed up.** `kolla-genpwd` will happily regenerate it, but the *existing* passwords won't change; losing the file means you can't easily re-run Kolla commands that depend on the original hashes.
- **Watch pool `size` and CRUSH placement.** At replication factor 2 across two compute hosts, losing either host still serves reads but blocks writes on full pools — plan OSD capacity with that headroom in mind.
- Consider whether `Asia/Kathmandu` timezone syncing should be managed by your config-management tooling instead of a one-shot loop, so new nodes inherit it automatically.

