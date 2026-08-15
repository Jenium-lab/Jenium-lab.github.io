# Masakari Host HA — Configuration, Troubleshooting & Test Runbook

**Environment:** Kolla-Ansible (2025.1, Ubuntu Noble), Pacemaker/Corosync + `pacemaker_remote`, Masakari 19.0.1, Nova, Ceph-backed compute nodes.
**Cluster:** 3 controllers (`controller-1/2/3`) + 2 compute nodes as pacemaker remote nodes (`compute-1`, `compute-2`).
**Segment:** `HA-Compute-Segment` (`recovery_method: auto`, `service_type: compute`).

---

## 1. Architecture Overview

Masakari's automatic host-failure recovery in this deployment relies on a chain of independent components. **Every one of them has to work correctly** for auto-evacuation to succeed — a failure anywhere in the chain silently breaks the whole pipeline without necessarily showing an obvious error.

```
[Pacemaker/Corosync cluster on controllers]
        |  monitors pacemaker_remote agent on each compute node
        v
[pacemaker_remote container on each compute node]
        |  reports node up/down to Pacemaker (crm_mon)
        v
[masakari-hostmonitor container on controllers]
        |  polls crm_mon, detects node state changes, sends notification
        v
[masakari-api / masakari-engine]
        |  runs taskflow recovery workflow: Disable -> Prepare -> Evacuate
        v
[Nova API]
        |  evacuate instance, requires compute service to be "down"
        v
[Instance moved to a healthy compute host]
```

Two health signals are **independent** and both matter:
- **Pacemaker/pacemaker_remote** — cluster membership / reachability of the node.
- **Nova's own `nova-compute` service heartbeat** — tracked via `report_interval` / `service_down_time`, completely separate from Pacemaker.

Masakari's evacuate call only succeeds once **both** signals agree the host is genuinely down.

---

## 2. Key Configuration

### 2.1 masakari-hostmonitor (`/etc/kolla/config/masakari/masakari-hostmonitor.conf` on the deploy host)

```ini
[host]
restrict_to_remotes = true
```

**This is critical and non-default.** Without it, hostmonitor reads node status via `cibadmin`/CIB (correct for full cluster members) instead of `crm_mon` (required for `pacemaker_remote` type nodes). See Problem #2 below — without this flag, compute node failures are **never** detected, silently.

### 2.2 masakari-engine (`/etc/kolla/config/masakari/masakari-engine.conf`)

Default values that matter for recovery timing (from `masakari/conf/engine.py`):

| Option | Default | Meaning |
|---|---|---|
| `wait_period_after_service_update` | 180s | Time masakari-engine sleeps after disabling the Nova compute service, before evacuating. |
| `wait_period_after_evacuation` | 90s | Time to wait/verify an instance actually evacuated. |
| `duplicate_notification_detection_interval` | 180s | Window in which identical notifications for the same host are deduped. |
| `verify_interval` | 1s | Polling interval used internally by looping calls. |

Masakari's `DisableComputeServiceTask` **only calls `enable_disable_service()`** (administrative disable) — it does **not** call `--force-down`. It relies entirely on Nova's own heartbeat timeout (`service_down_time`) having already marked the service down by the time the wait period elapses.

### 2.3 Nova timing (`nova.conf`, defaults — not overridden in this deployment)

| Option | Default | Meaning |
|---|---|---|
| `report_interval` | 10s | How often `nova-compute` reports a heartbeat. |
| `service_down_time` | 60s | If no heartbeat for this long, Nova considers the compute service down. |

**Relationship that makes evacuation work:** Masakari's 180s wait period is safely longer than Nova's 60s down-detection window, so by the time Masakari attempts evacuation, Nova should already see the service as down — *if* nothing else is interfering (see Problem #3).

### 2.4 Persisting config changes correctly

Kolla regenerates `/etc/kolla/<service>/<file>.conf` on every `kolla-ansible deploy`/`reconfigure` from a merge of:
```
role default template -> node_custom_config/global.conf -> node_custom_config/masakari/<service>.conf
  -> node_custom_config/masakari/masakari-monitors.conf -> per-host override
```
`node_custom_config` = `/etc/kolla/config` **on the Ansible/deploy host** (in this environment: `jumpserver`), not on the controllers themselves.

Editing the live file directly inside `/etc/kolla/<service>/` on a controller works immediately but **will be silently reverted** by the next `kolla-ansible deploy`/`reconfigure`. Always mirror the change into `/etc/kolla/config/masakari/...` on the deploy host, then run:
```bash
kolla-ansible reconfigure -i <inventory> --tags masakari
```

---

## 3. Problems Found & How They Were Solved

### Problem 1 — `pacemaker_remote` authkey mismatch (compute nodes stuck `RemoteOFFLINE`)

**Symptom:**
```
pcs status
  RemoteOFFLINE: [ compute-1 compute-2 ]
  Failed Resource Actions:
  * compute-1 start ... Timed Out: Connection refused without enough time to retry
```
`pacemaker-remoted.log` on the compute node showed:
```
error: TLS handshake with remote client failed: The TLS connection was non-properly terminated. | rc=-110
```

**Root cause:** The `authkey` used for the TLS handshake between controllers and the `pacemaker_remote` agent didn't match. The **on-disk source files** (`/etc/kolla/hacluster-pacemaker/authkey` on controllers, `/etc/kolla/hacluster-pacemaker-remote/authkey` on computes) were actually already correct/consistent everywhere — but the **running container** had an older, stale copy loaded into memory from before the file was last corrected. Kolla only copies config into the container at container **start** (`KOLLA_CONFIG_STRATEGY=COPY_ALWAYS`), so a running container never picks up a host-side file change until restarted.

**Fix:**
```bash
# on each affected compute node
docker restart hacluster_pacemaker_remote

# on a controller, once the remote agent is back up
docker exec hacluster_pacemaker pcs resource cleanup compute-1
docker exec hacluster_pacemaker pcs resource cleanup compute-2
```

**Verification:**
```bash
docker exec hacluster_pacemaker_remote md5sum /etc/pacemaker/authkey   # compare against controller's copy
docker exec hacluster_pacemaker pcs status                             # expect RemoteOnline / Started
```

---

### Problem 2 — masakari-hostmonitor never detects compute node failures (`restrict_to_remotes = false`)

**Symptom:** Even after Pacemaker correctly showed a compute node `RemoteOFFLINE`, `masakari-hostmonitor.log` repeated forever:
```
Recognized 'compute-1' as a new member of cluster. Host status is 'None'.
```
No notification was ever sent, regardless of how long you waited.

**Root cause (confirmed by reading the masakari-monitors source, `handle_host.py`):**
```python
if CONF.host.restrict_to_remotes:
    status_func = self._check_host_status_by_crm_mon      # correct for pacemaker_remote nodes
else:
    status_func = self._check_host_status_by_cibadmin      # correct only for full cluster members
```
With `restrict_to_remotes = false` (the shipped default), hostmonitor read node state via `cibadmin`/CIB, which doesn't carry usable `crmd` state for `pacemaker_remote`-type nodes — so `old_status` never resolves away from `None`, and the "is this a status change?" check never fires for compute nodes. Controllers (full cluster members) worked fine the whole time, which is why this bug was easy to miss at first.

**Fix:** set `restrict_to_remotes = true`.
- Immediate/live fix: edit `/etc/kolla/masakari-hostmonitor/masakari-monitors.conf` directly on the controller, then `docker restart masakari_hostmonitor`.
- **Persistent fix (required):**
  ```bash
  # on the deploy host (jumpserver), under /etc/kolla/config
  mkdir -p /etc/kolla/config/masakari
  cat > /etc/kolla/config/masakari/masakari-hostmonitor.conf << 'EOF'
  [host]
  restrict_to_remotes = true
  EOF
  kolla-ansible reconfigure -i <inventory> --tags masakari
  ```

**Verification:** after restart, watch the log for a real transition instead of the endless "new member" message:
```
'compute-1' is 'offline' (current: 'offline').
Send a notification. {'type': 'COMPUTE_HOST', ...}
```

---

### Problem 3 — Rogue native Pacemaker/Corosync install on `compute-2` blocking `pacemaker_remote`

**Symptom:** `pacemaker_remote` container crash-looped continuously:
```
error: Could not bind AF_UNIX (): Address already in use (98)
error: Could not start lrmd IPC server: Address already in use (-98)
error: Failed to create IPC server: shutting down and inhibiting respawn
```
Pacemaker on the controllers reported `Connection refused` for `compute-2` even though the host was reachable.

**Root cause:** `compute-2` had a **complete, independent, natively-installed Pacemaker+Corosync cluster stack** running directly on the host OS (`pacemakerd`, `pacemaker-based`, `pacemaker-fenced`, `pacemaker-execd`, etc. — the full stack, not just `pacemaker-remoted`), started via native `systemd` units (`pacemaker.service`, `corosync.service`), completely separate from the Kolla-managed containers. This native `pacemaker-execd` was holding the same local IPC socket the containerized `pacemaker_remote` needed, so the container could never bind and stayed in a permanent crash-restart loop. This native cluster also had a **stonith/fencing resource** (`fence_compute01`) configured and was actively attempting fencing actions due to a no-quorum condition — this should be treated as a serious finding on any host, since fencing can power off machines.

**Fix — full removal:**
```bash
systemctl stop pacemaker
systemctl stop corosync
systemctl disable pacemaker corosync corosync-qdevice

# confirm nothing left
ps aux | grep -iE "pacemaker|corosync"

apt-get purge -y pacemaker pacemaker-cli-utils pacemaker-common \
  pacemaker-resource-agents pcs python3-pacemaker libpacemaker1t64 \
  corosync corosync-notifyd corosync-qdevice libcorosync-common4
apt-get autoremove -y

rm -rf /etc/corosync /etc/pacemaker /var/lib/pacemaker /var/lib/corosync

systemctl start kolla-hacluster_pacemaker_remote-container.service
```

**Verification:**
```bash
tail -f /var/log/kolla/hacluster/pacemaker-remoted.log
# expect: "Pacemaker remote executor successfully started and accepting connections"
```
On controllers, native `pacemakerd`/`corosync` processes visible in `ps aux` are **expected and normal** — they are the containerized processes' host-level process tree (traceable back to `docker start -a hacluster_pacemaker` / `hacluster_corosync`). This is different from a genuine separate native install; confirm via `dpkg -l | grep -iE "pacemaker|corosync"` and check for unexpected stonith resources with `pcs stonith status` if in doubt.

---

### Problem 4 — Evacuation rejected: "Compute service ... is still in use"

**Symptom:** Masakari's recovery workflow ran and reached `EvacuateInstancesTask`, but failed:
```
Instance compute service state on compute-1 expected to be down, but it was up.
HTTP exception thrown: Compute service of compute-1 is still in use. (HTTP 400)
```

**Root cause:** This happened on test runs where only `hacluster_pacemaker_remote` (or `pacemaker`/network) was stopped, while `nova_compute` kept running and continued sending heartbeats. Pacemaker correctly saw the node as unreachable, but Nova's own service-down detection (independent signal, `service_down_time`) never tripped, because `nova-compute` was still alive and reporting in. Masakari's evacuate call requires **both** signals to agree — this is a deliberate Nova safety check preventing evacuation of a host that might still be running the instance (which would risk two VMs writing the same disk).

**This is not a bug** — it's a genuine gap between what was tested (partial failure: only the cluster-membership signal) and what a real host failure looks like (all signals down at once).

**Fix:** none needed in config — the fix is testing correctly (see Section 4). For a valid failure simulation, both `pacemaker_remote` **and** `nova_compute` (or the entire host) must go down together.

---

### Problem 5 — Notification stuck permanently in `running`, blocking future recovery

**Symptom:**
```
openstack segment host update ... --on_maintenance False
ConflictException: 409 ... Host ... can't be updated as it is in-use to process notifications.
```
`openstack notification list` showed a `COMPUTE_HOST` notification stuck at `status: running` indefinitely.

**Root cause:** `masakari_engine` restarted mid-workflow (its log showed a multi-hour gap consistent with an unplanned restart). Since Masakari's taskflow-based recovery runs in-process, the restart orphaned the in-flight job — nothing ever marked it `finished` or `error`, and the associated host stayed locked in maintenance mode indefinitely.

**Fix:** In this case the notification eventually self-resolved to `failed` after the engine came back up and re-evaluated it, which unblocked the maintenance-flag update. If it does **not** self-resolve, the notification's `status` needs to be updated directly in the Masakari database (`notifications` table) to `error`, after which the host's `on_maintenance` flag can be cleared normally via the CLI.

**Verification:**
```bash
openstack notification list                          # confirm no notification stuck at "running"
openstack segment host show HA-Compute-Segment <host> # confirm on_maintenance: False
```

**Operational note:** an unplanned `masakari_engine` restart during an active recovery is itself worth investigating/monitoring for in production — it silently breaks the recovery workflow for that event.

---

## 4. How To Test Correctly (Full, Realistic Failover Test)

### 4.1 What NOT to do
- `docker stop hacluster_pacemaker_remote` — the systemd unit (`kolla-hacluster_pacemaker_remote-container.service`) auto-restarts it within seconds; this doesn't simulate a failure at all.
- Stopping only `pacemaker_remote` while leaving `nova_compute` running — Pacemaker will detect the node as down, but Nova won't, and evacuation will be rejected (Problem #4). This tests detection only, not full recovery.

### 4.2 Recommended test: real host shutdown

This exercises every layer of the chain exactly as a genuine failure would.

**Step 1 — Capture baseline (both sides clean):**
```bash
docker exec hacluster_pacemaker pcs status
openstack compute service list --host <compute-x> --long
openstack server show <test-instance> -c status -c OS-EXT-SRV-ATTR:host
openstack segment host show HA-Compute-Segment <compute-x>
```
Expect: `RemoteOnline`, `Status: enabled` / `State: up` / `Forced Down: False`, instance `ACTIVE` on the target host, `on_maintenance: False`.

**Step 2 — Start watchers in separate terminals, leave running:**
```bash
# on the deploy host / any client with openstack CLI
watch -n 10 "date; echo; openstack compute service list --host <compute-x> --long; echo; openstack notification list"

# on a controller
tail -f /var/log/kolla/masakari/masakari-hostmonitor.log

# on a controller
watch -n 10 "docker exec hacluster_pacemaker pcs status"
```

**Step 3 — Trigger a real failure:**
```bash
# on the target compute node
shutdown -h now
```
(A hard power-off/console force-stop from the underlying hypervisor is an even closer simulation of a real crash than a graceful `shutdown -h now`, since the latter may let some services deregister cleanly.)

**Step 4 — Observe, without touching anything, until it resolves:**
Expected order of events (approximate timings observed in this environment):
1. ~1–2 min: Pacemaker marks the node `RemoteOFFLINE`.
2. Within the next hostmonitor poll cycle (~60s): notification generated (`STOPPED`/`OFFLINE`), Nova's `State` flips to `down` around the same time.
3. `DisableComputeServiceTask` runs, ~180s wait (`wait_period_after_service_update`).
4. `PrepareHAEnabledInstancesTask` — enumerates instances on the failed host.
5. `EvacuateInstancesTask` — evacuates each instance; on success the notification status becomes `finished`.

Total observed time from real shutdown to instance running again on a healthy host: **~8–9 minutes** in this environment.

**Step 5 — Confirm the result:**
```bash
openstack notification show <notification-uuid>       # check recovery_workflow_details, status: finished
openstack server show <test-instance> -c status -c OS-EXT-SRV-ATTR:host -c OS-EXT-STS:task_state
```
Success = instance `ACTIVE`, `OS-EXT-SRV-ATTR:host` now shows a **different** (healthy) compute host.

---

## 5. Cleanup After Testing

Run all of these after every test cycle, real or simulated, to return the environment to a clean baseline.

**1. Power the failed host back on** (out-of-band console/hypervisor access — SSH won't work while it's off).

**2. Confirm its services came back up:**
```bash
systemctl status kolla-hacluster_pacemaker_remote-container.service
systemctl status kolla-nova_compute-container.service
```

**3. Clean up Pacemaker's view of the node:**
```bash
docker exec hacluster_pacemaker pcs resource cleanup <compute-x>
sleep 15
docker exec hacluster_pacemaker pcs status     # expect RemoteOnline / Started
```

**4. Clear the maintenance flag Masakari sets during recovery:**
```bash
openstack segment host show HA-Compute-Segment <compute-x>
# if on_maintenance: True
openstack segment host update HA-Compute-Segment <compute-x> --on_maintenance False
```
If this returns `409 ... in-use to process notifications`, check for a stuck `running` notification first (see Problem #5) before retrying.

**5. Re-enable the Nova compute service** (Masakari's `DisableComputeServiceTask` leaves it administratively disabled):
```bash
openstack compute service list --host <compute-x> --long
openstack compute service set <compute-x> nova-compute --enable
```

**6. Confirm the evacuated instance (or original instance, if evacuation didn't happen) is healthy:**
```bash
openstack server show <test-instance> -c status -c OS-EXT-SRV-ATTR:host -c OS-EXT-STS:task_state
```

**7. Clear any stale Pacemaker failcounts if `Failed Resource Actions` still shows old entries:**
```bash
docker exec hacluster_pacemaker pcs resource cleanup <compute-x>
```

---

## 6. Quick Reference — Command Cheat Sheet

```bash
# Cluster / Pacemaker
docker exec hacluster_pacemaker pcs status
docker exec hacluster_pacemaker pcs resource cleanup <node>
docker exec hacluster_pacemaker pcs resource config <node>
docker exec hacluster_pacemaker crm_mon -X

# Masakari
openstack segment host list HA-Compute-Segment
openstack segment host show HA-Compute-Segment <host>
openstack segment host update HA-Compute-Segment <host> --on_maintenance False
openstack notification list
openstack notification show <uuid>

# Nova
openstack compute service list --host <host> --long
openstack compute service set <host> nova-compute --enable
openstack server show <instance> -c status -c OS-EXT-SRV-ATTR:host -c OS-EXT-STS:task_state

# Logs
tail -f /var/log/kolla/masakari/masakari-hostmonitor.log
tail -f /var/log/kolla/masakari/masakari-engine.log
tail -f /var/log/kolla/hacluster/pacemaker-remoted.log   # on compute nodes
```

---

## 7. Open Items / Recommendations

- **Persist `restrict_to_remotes = true`** via `/etc/kolla/config/masakari/masakari-hostmonitor.conf` on the deploy host if not already done, then run `kolla-ansible reconfigure --tags masakari` — otherwise a future `kolla-ansible deploy` will silently revert this fix.
- **Audit all compute nodes** for the rogue native Pacemaker/Corosync issue found on `compute-2` (Problem #3) — check `dpkg -l | grep -iE "pacemaker|corosync"` and `ps aux | grep -iE "pacemaker|corosync"` on every compute node, not just the ones already tested. If found elsewhere, investigate the fencing resource (`fence_compute01`-style) configuration before removing it, since it may indicate leftover state from an earlier deployment attempt.
- **Monitor for unplanned `masakari_engine` restarts** — these orphan in-flight recovery workflows (Problem #5) and can leave hosts stuck in maintenance mode, silently blocking future auto-recovery until manually cleared.
- Consider whether `wait_period_after_service_update` (180s default) is acceptable for your RTO requirements, or whether it should be tuned — it's a large fraction of the total ~8–9 minute recovery time observed.
