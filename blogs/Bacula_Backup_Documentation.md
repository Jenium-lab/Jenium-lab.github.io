# Bacula Community — Backup Infrastructure Documentation
### OpenStack VM File-Level Backup
**Director • Storage Daemon • File Daemon • Multi-Client**

---

## 1. Architecture Overview

Bacula is a network backup solution with three core daemons that communicate over TCP/IP. Each daemon has its own configuration file and must authenticate to the others using shared passwords.

| Daemon | Service Name | Default Port | Config File |
|---|---|---|---|
| Director (DIR) | bacula-director | 9101 | /etc/bacula/bacula-dir.conf |
| Storage Daemon (SD) | bacula-sd | 9103 | /etc/bacula/bacula-sd.conf |
| File Daemon (FD) | bacula-fd | 9102 | /etc/bacula/bacula-fd.conf |

> **INFO:** The Director is the brain — it orchestrates all jobs. The Storage Daemon writes data to disk/tape. The File Daemon runs on each client VM and sends data to the Storage Daemon.

### Communication Flow

```
  OpenStack VM (FD)          Bacula Server
  ┌──────────────────┐       ┌─────────────────────────────┐
  │  bacula-fd       │◄─────►│  bacula-dir  (port 9101)    │
  │  port 9102       │       │  bacula-sd   (port 9103)    │
  └──────────────────┘       └─────────────────────────────┘
                                        │
                               /bacula/backup/ (Storage)
```

---

## 2. Critical Config Values — What Must Match

> **WARNING:** Every password and name listed below must be copied exactly — they are case-sensitive.

### 2.1 Director ↔ File Daemon (Client)

When the Director connects to a client VM's File Daemon, it authenticates using the client's password. This password must appear in two places:

| Field | bacula-fd.conf (on each VM) | bacula-dir.conf (on server) |
|---|---|---|
| Director Name | `Name = "bacula-dir"` | `Director { Name = "bacula-dir" }` |
| Client Password | `Password = "SecretVM1Pass!"` | `Client { Password = "SecretVM1Pass!" }` |
| FD Name | `FileDaemon { Name = "vm1-fd" }` | `Client { Name = "vm1-fd" }` |

> **WARNING:** The Director Name in bacula-fd.conf must match the actual Director resource name in bacula-dir.conf exactly.

### 2.2 Director ↔ Storage Daemon

| Field | bacula-sd.conf (on server) | bacula-dir.conf (on server) |
|---|---|---|
| SD Name | `Storage { Name = "bacula-sd" }` | `Storage { SDAddress = ... }` |
| SD Password | `Director { Password = "SDPass123!" }` | `Storage { Password = "SDPass123!" }` |
| Director Name | `Director { Name = "bacula-dir" }` | `Director { Name = "bacula-dir" }` |

### 2.3 Console ↔ Director

| Field | bconsole.conf | bacula-dir.conf |
|---|---|---|
| Director Address | `DIRaddress = <server-ip>` | `Director { DirAddress = <server-ip> }` |
| Director Name | `Director { Name = "bacula-dir" }` | `Director { Name = "bacula-dir" }` |
| Console Password | `Director { Password = "ConsPass!" }` | `Console { Password = "ConsPass!" }` |

---

## 3. Complete Configuration Files

### 3.1 bacula-dir.conf (Bacula Server)

This is the master configuration file on the Bacula server. It defines every client, job, schedule, fileset, storage, and pool.

#### Director Resource

```ini
Director {
  Name = "bacula-dir"          # ← Must match Director Name in all FDs and SD
  DIRport = 9101
  QueryFile = "/etc/bacula/query.sql"
  WorkingDirectory = "/var/lib/bacula"
  PidDirectory = "/run/bacula"
  Maximum Concurrent Jobs = 20
  Password = "ConsolePassword123!"  # ← Must match bconsole.conf
  Messages = Daemon
}
```

#### Storage Resource

```ini
Storage {
  Name = "File1"
  Address = 127.0.0.1          # Storage Daemon address
  SDPort = 9103
  Password = "SDPassword123!"  # ← Must match SD Director block password
  Device = "FileStorage"       # ← Must match Device Name in bacula-sd.conf
  Media Type = "File"
}
```

#### Client Resources (one per VM)

```ini
Client {
  Name = "vm1-fd"              # ← Must match FileDaemon Name in vm1 bacula-fd.conf
  Address = 192.168.1.101      # OpenStack VM IP
  FDPort = 9102
  Catalog = "MyCatalog"
  Password = "VM1Password!"    # ← Must match Director Password in vm1 bacula-fd.conf
  File Retention = 30 days
  Job Retention = 6 months
  AutoPrune = yes
}

Client {
  Name = "vm2-fd"
  Address = 192.168.1.102
  FDPort = 9102
  Catalog = "MyCatalog"
  Password = "VM2Password!"    # ← Different password per VM (recommended)
  File Retention = 30 days
  Job Retention = 6 months
  AutoPrune = yes
}
```

#### FileSet Resource (shared across jobs)

```ini
FileSet {
  Name = "Linux-Common-FileSet"
  Include {
    Options {
      signature = MD5
      Compression = GZIP
    }
    File = /etc
    File = /home
    File = /opt
    File = /var/www
  }
  Exclude {
    File = /proc
    File = /sys
    File = /tmp
    File = /dev
    File = /run
  }
}
```

#### Schedule Resource (shared across jobs)

```ini
Schedule {
  Name = "VM-Daily-Schedule"
  Run = Full        1st sun at 02:00
  Run = Differential 2nd-5th sun at 02:00
  Run = Incremental  mon-sat at 02:00
}
```

#### Job Resources

```ini
Job {
  Name = "Backup-VM1"
  Type = Backup
  Level = Incremental
  Client = "vm1-fd"
  FileSet = "Linux-Common-FileSet"
  Schedule = "VM-Daily-Schedule"
  Storage = "File1"
  Messages = Standard
  Pool = "File"
  Priority = 10
  Write Bootstrap = "/var/lib/bacula/vm1.bsr"
}

Job {
  Name = "Backup-VM2"
  Type = Backup
  Level = Incremental
  Client = "vm2-fd"
  FileSet = "Linux-Common-FileSet"
  Schedule = "VM-Daily-Schedule"
  Storage = "File1"
  Messages = Standard
  Pool = "File"
  Priority = 10
  Write Bootstrap = "/var/lib/bacula/vm2.bsr"
}

# One restore job covers ALL clients — select at runtime
Job {
  Name = "Restore-Any-VM"
  Type = Restore
  Client = "vm1-fd"            # Default; override with: restore client=vm2-fd
  FileSet = "Linux-Common-FileSet"
  Storage = "File1"
  Pool = "File"
  Messages = Standard
  Where = /tmp/bacula-restore
}
```

---

### 3.2 bacula-sd.conf (Bacula Server)

The Storage Daemon configuration. Defines where backup data is physically stored and which Directors are allowed to connect.

```ini
Storage {
  Name = "bacula-sd"
  SDPort = 9103
  WorkingDirectory = "/var/lib/bacula"
  PidDirectory = "/run/bacula"
  Maximum Concurrent Jobs = 20
}

Director {
  Name = "bacula-dir"          # ← Must match Director Name in bacula-dir.conf
  Password = "SDPassword123!"  # ← Must match Storage Password in bacula-dir.conf
}

Device {
  Name = "FileStorage"         # ← Must match Device in Storage resource (bacula-dir.conf)
  Media Type = "File"
  Archive Device = "/bacula/backup"  # Actual path on disk where backups are stored
  LabelMedia = yes
  Random Access = Yes
  AutomaticMount = yes
  RemovableMedia = no
  AlwaysOpen = no
}

Messages {
  Name = Standard
  director = bacula-dir = all
}
```

---

### 3.3 bacula-fd.conf (On Each OpenStack VM)

Install bacula-client on every OpenStack VM and configure this file. Each VM must have a unique Name and unique Password.

#### VM1 — /etc/bacula/bacula-fd.conf

```ini
Director {
  Name = "bacula-dir"          # ← Must match Director Name in bacula-dir.conf
  Password = "VM1Password!"    # ← Must match Client Password in bacula-dir.conf
}

FileDaemon {
  Name = "vm1-fd"              # ← Must match Client Name in bacula-dir.conf
  FDport = 9102
  WorkingDirectory = /var/lib/bacula
  Pid Directory = /run/bacula
  Maximum Concurrent Jobs = 20
}

Messages {
  Name = Standard
  director = bacula-dir = all, !skipped, !restored
}
```

#### VM2 — /etc/bacula/bacula-fd.conf

```ini
Director {
  Name = "bacula-dir"          # ← Same Director Name (same server)
  Password = "VM2Password!"    # ← DIFFERENT password for each VM
}

FileDaemon {
  Name = "vm2-fd"              # ← DIFFERENT unique name for each VM
  FDport = 9102
  WorkingDirectory = /var/lib/bacula
  Pid Directory = /run/bacula
  Maximum Concurrent Jobs = 20
}

Messages {
  Name = Standard
  director = bacula-dir = all, !skipped, !restored
}
```

> **TIP:** For each additional VM: change ONLY the FileDaemon Name (e.g., vm3-fd) and the Password. The Director Name stays the same for all VMs pointing to the same Bacula server.

---

### 3.4 bconsole.conf (Bacula Server)

```ini
Director {
  Name = "bacula-dir"               # ← Must match Director Name in bacula-dir.conf
  DIRport = 9101
  address = 127.0.0.1
  Password = "ConsolePassword123!"  # ← Must match Console Password in bacula-dir.conf
}
```

---

## 4. Name & Password Cross-Reference

| Value | Set In (source) | Must Also Appear In |
|---|---|---|
| Director Name | bacula-dir.conf — `Director { Name = "bacula-dir" }` | bacula-fd.conf, bacula-sd.conf, bconsole.conf |
| Client Password (per VM) | bacula-fd.conf — `Director { Password = "VMxPass" }` | bacula-dir.conf — `Client { Password = "VMxPass" }` |
| Client Name (per VM) | bacula-fd.conf — `FileDaemon { Name = "vmx-fd" }` | bacula-dir.conf — `Client { Name }` and `Job { Client }` |
| SD Password | bacula-sd.conf — `Director { Password = "SDPass" }` | bacula-dir.conf — `Storage { Password = "SDPass" }` |
| SD Device Name | bacula-sd.conf — `Device { Name = "FileStorage" }` | bacula-dir.conf — `Storage { Device = "FileStorage" }` |
| Console Password | bacula-dir.conf — `Console { Password = "ConsPass" }` | bconsole.conf — `Director { Password = "ConsPass" }` |

---

## 5. Installation Steps

### 5.1 Bacula Server

**Ubuntu / Debian**
```bash
sudo apt update
sudo apt install -y bacula bacula-common bacula-director-sqlite3 \
                    bacula-storage bacula-console
```

**RHEL / CentOS / Rocky Linux**
```bash
sudo dnf install -y bacula-director bacula-storage bacula-console bacula-client
```

### 5.2 File Daemon on Each OpenStack VM

**Ubuntu / Debian**
```bash
sudo apt update && sudo apt install -y bacula-client
```

**RHEL / CentOS / Rocky Linux**
```bash
sudo dnf install -y bacula-client
```

### 5.3 Enable & Start Services

**On Bacula Server**
```bash
sudo systemctl enable bacula-director bacula-sd
sudo systemctl start  bacula-director bacula-sd
sudo systemctl status bacula-director bacula-sd
```

**On Each VM**
```bash
sudo systemctl enable bacula-fd
sudo systemctl start  bacula-fd
sudo systemctl status bacula-fd
```

### 5.4 Firewall Configuration

**OpenStack VM (OS-level firewall)**
```bash
# Ubuntu/Debian
sudo ufw allow 9102/tcp

# RHEL/CentOS
sudo firewall-cmd --permanent --add-port=9102/tcp
sudo firewall-cmd --reload
```

**OpenStack Security Group**
```bash
openstack security group rule create \
  --protocol tcp \
  --dst-port 9102 \
  --remote-ip <BACULA_SERVER_IP>/32 \
  <your-security-group-name>
```

---

## 6. Recommended Config Directory Layout

```
/etc/bacula/
├── bacula-dir.conf          # Main config — contains @include references
├── bacula-sd.conf           # Storage Daemon config
├── bacula-fd.conf           # File Daemon config (only on client VMs)
├── bconsole.conf            # Console config
├── clients/
│   ├── vm1.conf
│   ├── vm2.conf
│   └── vm3.conf
├── jobs/
│   ├── backup-vm1.conf
│   ├── backup-vm2.conf
│   └── restore-all.conf
├── filesets/
│   └── common.conf
└── schedules/
    └── daily.conf
```

In `bacula-dir.conf` use `@include` to pull in all split files:

```ini
@/etc/bacula/filesets/common.conf
@/etc/bacula/schedules/daily.conf
@/etc/bacula/clients/vm1.conf
@/etc/bacula/clients/vm2.conf
@/etc/bacula/jobs/backup-vm1.conf
@/etc/bacula/jobs/backup-vm2.conf
@/etc/bacula/jobs/restore-all.conf
```

---

## 7. Verification & bconsole Commands

### 7.1 Verify Config Syntax

```bash
sudo bacula-dir -t -c /etc/bacula/bacula-dir.conf
sudo bacula-sd  -t -c /etc/bacula/bacula-sd.conf
sudo bacula-fd  -t -c /etc/bacula/bacula-fd.conf
```

### 7.2 Reload After Config Changes

```bash
echo 'reload' | sudo bconsole
sudo systemctl restart bacula-director
```

### 7.3 Common bconsole Commands

| Command | Description |
|---|---|
| `status client=vm1-fd` | Test connection to a specific VM's FD |
| `status client=vm2-fd` | Test connection to another VM |
| `run job=Backup-VM1` | Manually trigger a backup job |
| `run job=Backup-VM1 level=Full` | Force a full backup |
| `list jobs` | List all jobs across all clients |
| `list jobs client=vm2-fd` | List jobs for a specific client |
| `list files jobid=<ID>` | List files backed up in a job |
| `restore client=vm1-fd` | Restore files to VM1 |
| `restore client=vm2-fd where=/tmp/restore` | Restore to alternate path |
| `messages` | View recent log messages |
| `quit` | Exit bconsole |

---

## 8. Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| Authorization error | Password mismatch between FD and DIR | Ensure Client Password in DIR matches Director Password in FD exactly |
| Connection refused on 9102 | Firewall or security group blocking port | Open port 9102 in OS firewall and OpenStack security group |
| Fatal error: Director name mismatch | Director Name in FD does not match actual DIR name | Check `Director { Name }` in bacula-fd.conf matches bacula-dir.conf |
| bacula-fd not starting | Config syntax error | Run: `bacula-fd -t -c /etc/bacula/bacula-fd.conf` |
| Cannot connect to SD | SD Password mismatch or wrong Device name | Verify Storage Password in DIR matches Director Password in SD |
| Files missing from backup | FileSet paths do not exist on VM | Verify Include File paths in FileSet exist on the client VM |

### 8.1 Useful Log Locations

```bash
# Director log
journalctl -u bacula-director -n 100 --no-pager

# Storage Daemon log
journalctl -u bacula-sd -n 100 --no-pager

# File Daemon log (run on the VM)
journalctl -u bacula-fd -n 100 --no-pager

# Test TCP connectivity from Bacula server to VM
telnet <VM_IP> 9102
```

---

## 9. Setup Checklist

### On Each New OpenStack VM
- [ ] Install bacula-client package
- [ ] Edit `/etc/bacula/bacula-fd.conf` — set unique FileDaemon Name (e.g., vm3-fd)
- [ ] Set Director Password — use a unique strong password
- [ ] Open port 9102 in OS firewall
- [ ] Enable and start bacula-fd service
- [ ] Open port 9102 in the OpenStack Security Group

### On the Bacula Server
- [ ] Add `Client {}` block in bacula-dir.conf with matching Name and Password
- [ ] Add `Job {}` block (Backup-VMx) referencing the new Client
- [ ] Reuse existing FileSet and Schedule
- [ ] Ensure Write Bootstrap path is unique per job
- [ ] Test syntax: `bacula-dir -t -c /etc/bacula/bacula-dir.conf`
- [ ] Reload Director: `echo 'reload' | sudo bconsole`
- [ ] Test connection: `status client=vm3-fd` in bconsole
- [ ] Run a test full backup: `run job=Backup-VM3 level=Full`

---

*End of Document*
