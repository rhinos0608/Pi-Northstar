# Northstar Native Installer & Service Management Guide

This document describes installation, verification, operation, and uninstallation of the native Northstar Broker service across macOS, Windows, and Linux.

---

## Architecture & Security Invariants

### 1. Zero Elevation via npm or Node
- **Strict Invariant**: Neither `npm postinstall`, `sudo northstar`, nor any Node.js process may ever invoke privilege escalation or install system daemons.
- The npm package serves strictly as client, executor, and installer locator.
- System services and broker binaries must be installed exclusively through native platform installers (`.pkg`, `.msi`, system packages/units) or explicit system administrator commands.

### 2. Native Authority Boundary
- The broker (`northstar-broker`) enforces kernel peer attestation (UID/PID on Unix, SID/PID on Windows).
- Stateful CLI commands connect only to a running healthy broker; absent broker fails closed with a typed unavailable error and never auto-spawns privileged background authority.

---

## macOS Installation & Management

### Prerequisites
- macOS 12+ (Apple Silicon or Intel x86_64).
- Root / administrative privileges for installer execution.

### Installation via Signed Package (.pkg)
```bash
sudo installer -pkg northstar-broker.pkg -target /
```

### What the Installer Does
1. Installs `/usr/local/bin/northstar-broker` (root-owned, 0755).
2. Installs `/Library/LaunchDaemons/com.pi.northstar.broker.plist`.
3. Runs `postinstall` script:
   - Allocates 4 isolated worker pool service accounts: `_northstar_pool_1` through `_northstar_pool_4` with UIDs 451–454, shell `/usr/bin/false`, home `/var/empty`, and `IsHidden 1`.
   - Appends pool accounts to `/Library/Preferences/com.apple.loginwindow` (`HiddenUsersList`) to keep them off login UI.
   - Creates `/var/log/northstar` for broker stdout/err logs.
   - Loads and bootstraps the `com.pi.northstar.broker` launchd daemon.

### Verifying Service Status
```bash
# Check launchd service status
sudo launchctl list | grep com.pi.northstar.broker

# Check logs
cat /var/log/northstar/broker.log
cat /var/log/northstar/broker.err
```

### Signature Verification Commands
Verify the `.pkg` installer signature and notarization before running:
```bash
# Verify installer signature
pkgutil --check-signature northstar-broker.pkg

# Assess Gatekeeper / notarization validity
spctl --assess --type install northstar-broker.pkg

# Verify binary codesign and hardened runtime
codesign --verify --verbose=4 /usr/local/bin/northstar-broker
spctl --assess --type execute --verbose /usr/local/bin/northstar-broker
```

### Uninstallation & Pool Account Deletion
To completely remove the service, configuration, and all isolated pool accounts:
```bash
# 1. Stop and unload launchd daemon
sudo launchctl bootout system/com.pi.northstar.broker 2>/dev/null || sudo launchctl unload /Library/LaunchDaemons/com.pi.northstar.broker.plist 2>/dev/null || true

# 2. Remove binary and daemon plist
sudo rm -f /Library/LaunchDaemons/com.pi.northstar.broker.plist
sudo rm -f /usr/local/bin/northstar-broker

# 3. Delete isolated dscl pool accounts (UIDs 451-454)
for i in 1 2 3 4; do
  sudo dscl . -delete /Users/_northstar_pool_$i 2>/dev/null || true
done

# 4. Optional: Remove log directory
sudo rm -rf /var/log/northstar
```

---

## Windows Installation & Management

### Prerequisites
- Windows 10 / Server 2016 or later (x64 or ARM64).
- Administrative command prompt or PowerShell.

### Installation via MSI
```powershell
msiexec /i northstar-broker.msi /qn
```
Or run interactive MSI setup.

### What the Installer Does
1. Installs `northstar-broker.exe` into `C:\Program Files\Northstar\`.
2. Registers and starts the `NorthstarBroker` Windows Service under `LocalSystem` account with `auto` startup.
3. Named pipe `\\.\pipe\northstar-broker` is created by the service at runtime with a least-privilege DACL (not created by MSI).

### Verifying Service Status
```powershell
# Query service status via SC or PowerShell
Get-Service -Name NorthstarBroker
sc.exe query NorthstarBroker
```

### Signature Verification Commands
```powershell
# Verify Authenticode digital signature on MSI and binary
Get-AuthenticodeSignature "C:\Program Files\Northstar\northstar-broker.exe"
Get-AuthenticodeSignature .\northstar-broker.msi
```

### Uninstallation
```powershell
# Silent uninstallation via MSI
msiexec /x northstar-broker.msi /qn

# Or via product code / Settings -> Installed Apps
```

---

## Linux Installation & Management

### Prerequisites
- Linux with systemd (system manager / PID 1, supporting `DynamicUser=yes`).
- Root privileges (`sudo`).

### Installation via Systemd Unit & Tarball
```bash
# 1. Unpack binary
sudo tar -xzf northstar-broker-linux-x64.tar.gz -C /usr/local/bin/
sudo chown root:root /usr/local/bin/northstar-broker
sudo chmod 0755 /usr/local/bin/northstar-broker

# 2. Install systemd service unit
sudo cp installer/systemd/northstar-broker.service /etc/systemd/system/
sudo systemctl daemon-reload

# 3. Enable and start service
sudo systemctl enable --now northstar-broker.service
```

### Verifying Service Status
```bash
# Check service status
systemctl status northstar-broker.service

# Inspect systemd journal logs
journalctl -u northstar-broker.service -f
```

### Uninstallation
```bash
# 1. Stop and disable service
sudo systemctl disable --now northstar-broker.service

# 2. Remove unit and binary
sudo rm -f /etc/systemd/system/northstar-broker.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/northstar-broker
```
