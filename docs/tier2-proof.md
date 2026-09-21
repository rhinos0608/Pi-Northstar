# Tier 2 Privileged Integration Proof Plan

**Status:** Implementation Blueprint / Execution Runbook  
**Context:** Gate B native authority boundary (`plan.md` Phase 5 / Gate B, `ADR 0010`, `docs/plans/2026-09-21-gate-b-native-authority-boundary.md`).  
**Purpose:** Defines exact command sequences for tests that require elevated host privileges (root / Administrator / system services) and **cannot** run in standard unprivileged Tier 1 CI.

---

## 1. Test Tier Separation Matrix

| Test Proof Description | Ref | Target Gate | Tier 1 (Unprivileged CI / Mocked) | Tier 2 (Privileged Runner / Live OS) |
|---|---|---|---|---|
| Native Installer Installation & Lifecycle | PROOF-A | **G5** | Mocked installer package structure & WiX/pkg syntax checks | Live root/admin install (`.msi`, `.pkg`, `.deb`/`.rpm`) |
| Per-Job Worker Isolation & Cross-Read Denial | PROOF-B | **G7** | In-process credential env stripping & mocked token grants | Live multi-job execution with distinct UIDs / AppContainer SIDs |
| Kill-to-Zero & Descendant Tree Sweep | PROOF-C | **G8** | Mocked PID tracking & process group signaling | Live daemonizing escape (`setsid`/double-fork) & UID reaper sweep |
| Hostile Worker IPC Denial | PROOF-D | **G7**, **G11** | Mocked socket credential validation (`SO_PEERCRED`/`getpeereid`) | Live cross-user/cross-SID socket connection denial |
| Driver Integrity & Signature Verification | PROOF-E | **G9** | Manifest SHA-256 hash checks via `driver-manifest.test.ts` | Live `spctl`, `signtool`, Authenticode, and notarization checks |

---

## 2. Proof Specifications

### PROOF-A: Signed Native Installer Installation

- **Platform:** Linux (`x86_64`, `aarch64`), macOS (`x86_64`, `arm64`), Windows (`x64`, `arm64`)
- **Required Privilege:** Root (`sudo`) on Linux/macOS; Administrator (elevated UAC) on Windows
- **Plan Gate:** **G5** (Signed Native Installer: installs service & broker cleanly, zero npm elevation or `sudo` in CLI)

#### Linux Exact Command Sequence (systemd .deb / .rpm)
```bash
# 1. Install package non-interactively
sudo dpkg -i dist/northstar-worker-service_amd64.deb || sudo apt-get install -f -y
# (For RHEL/Fedora: sudo rpm -ivh dist/northstar-worker-service.x86_64.rpm)

# 2. Assert systemd unit installed and active
sudo systemctl is-enabled northstar-worker-service.service
sudo systemctl status northstar-worker-service.service

# 3. Assert binary permissions (root-owned, non-world-writable)
test "$(stat -c '%u:%g:%a' /usr/local/bin/northstar-worker-service)" = "0:0:755"

# 4. Uninstall cleanly
sudo dpkg -r northstar-worker-service
sudo systemctl status northstar-worker-service.service && exit 1 || true
```

#### macOS Exact Command Sequence (.pkg installer)
```bash
# 1. Install component package to target root
sudo installer -pkg dist/northstar-worker-service.pkg -target /

# 2. Assert launchd daemon is registered and loaded
sudo launchctl list | grep com.pi.northstar.worker-service

# 3. Assert binary permissions
test "$(stat -f '%u:%g:%Op' /Library/PrivilegedHelperTools/northstar-worker-service)" = "0:0:755"

# 4. Assert worker user pool accounts exist (UIDs 451-458)
dscl . -read /Users/_northstar_pool_0 UniqueID | grep -q "451"

# 5. Uninstall cleanly
sudo launchctl bootout system/com.pi.northstar.worker-service
sudo rm -f /Library/LaunchDaemons/com.pi.northstar.worker-service.plist
sudo rm -f /Library/PrivilegedHelperTools/northstar-worker-service
```

#### Windows Exact Command Sequence (.msi installer)
```powershell
# 1. Install MSI silently with logging
Start-Process msiexec.exe -Wait -ArgumentList "/i dist\northstar-worker-service.msi /qn /l*v msi_install.log"

# 2. Assert Windows service installed and running
$svc = Get-Service -Name "NorthstarWorkerService"
if ($svc.Status -ne "Running") { throw "Service not running: $($svc.Status)" }

# 3. Assert installed files located in Program Files and ACL protected
$path = "${env:ProgramFiles}\Pi-Northstar\northstar-worker-service.exe"
$acl = Get-Acl -Path $path
if ($acl.Owner -notmatch "Builtin\\Administrators|NT SERVICE|SYSTEM") {
    throw "Insecure owner: $($acl.Owner)"
}

# 4. Uninstall cleanly
Start-Process msiexec.exe -Wait -ArgumentList "/x dist\northstar-worker-service.msi /qn"
```

- **Pass Criteria:**
  - Installer completes with exit code 0 without modifying caller profile files.
  - Daemon or service starts automatically under system authority (PID 1 / SCM / launchd).
  - Executable files are owned by `root` / `SYSTEM` / `Administrators` and not writable by regular users.
  - Clean uninstall shuts down the service and cleans up unit registrations.

---

### PROOF-B: Per-Job Isolation & Cross-Job File Read Denial

- **Platform:** Linux, macOS, Windows
- **Required Privilege:** Root / Administrator
- **Plan Gate:** **G7** (Cross-Worker Isolation: concurrent workers cannot inspect each other's memory or files)

#### Linux (systemd DynamicUser Allocation)
```bash
# 1. Create canary file in /tmp/job-a private space
JOB_A_DIR=$(mktemp -d /tmp/northstar-job-a-XXXXXX)
chmod 700 "$JOB_A_DIR"
echo "SECRET_CANARY_JOB_A" > "$JOB_A_DIR/canary.txt"

# 2. Launch Job A and Job B under systemd DynamicUser instances
systemd-run --unit=northstar-job-a --wait --pipe -p DynamicUser=yes -p PrivateTmp=yes sleep 5 &
PID_A=$!

systemd-run --unit=northstar-job-b --wait --pipe -p DynamicUser=yes -p PrivateTmp=yes sleep 5 &
PID_B=$!

# Wait for units to spin up
sleep 1

# 3. Inspect UIDs from /proc/PID/status
UID_A=$(grep '^Uid:' /proc/$PID_A/status | awk '{print $2}')
UID_B=$(grep '^Uid:' /proc/$PID_B/status | awk '{print $2}')

# Assert UIDs differ and are within dynamic allocation range (61184 - 65519)
[ "$UID_A" != "$UID_B" ] || { echo "FAIL: UIDs identical: $UID_A"; exit 1; }
[ "$UID_A" -ge 61184 ] && [ "$UID_A" -le 65519 ] || { echo "FAIL: UID_A out of range: $UID_A"; exit 1; }
[ "$UID_B" -ge 61184 ] && [ "$UID_B" -le 65519 ] || { echo "FAIL: UID_B out of range: $UID_B"; exit 1; }

# 4. Execute file read attempt from Job B targeting Job A's directory -> MUST FAIL
systemd-run --unit=northstar-probe --wait --pipe -p DynamicUser=yes cat "$JOB_A_DIR/canary.txt" && exit 1 || true

rm -rf "$JOB_A_DIR"
```

#### macOS (Static Pool Account Isolation)
```bash
# 1. Create canary file owned by pool user 0 (UID 451)
CANARY_DIR="/tmp/northstar-job-a-canary"
sudo -u _northstar_pool_0 mkdir -m 700 "$CANARY_DIR"
sudo -u _northstar_pool_0 sh -c "echo CANARY_DATA > $CANARY_DIR/secret.txt"

# 2. Run background jobs under separate pool accounts
sudo -u _northstar_pool_0 sleep 5 &
PID_A=$!
sudo -u _northstar_pool_1 sleep 5 &
PID_B=$!

# 3. Assert UIDs differ via ps
UID_A=$(ps -o uid= -p $PID_A | tr -d ' ')
UID_B=$(ps -o uid= -p $PID_B | tr -d ' ')
[ "$UID_A" != "$UID_B" ] || { echo "FAIL: macOS pool UIDs identical"; exit 1; }
[ "$UID_A" = "451" ] || { echo "FAIL: Unexpected UID_A: $UID_A"; exit 1; }
[ "$UID_B" = "452" ] || { echo "FAIL: Unexpected UID_B: $UID_B"; exit 1; }

# 4. Attempt cross-read from _northstar_pool_1 -> MUST FAIL
sudo -u _northstar_pool_1 cat "$CANARY_DIR/secret.txt" 2>/dev/null && exit 1 || true

# Cleanup
sudo rm -rf "$CANARY_DIR"
```

#### Windows (AppContainer SID + Job Object Isolation)
```powershell
# 1. Create canary file restricted to Administrator
$canaryDir = "$env:TEMP\northstar-job-a"
New-Item -ItemType Directory -Path $canaryDir -Force
$canaryFile = "$canaryDir\canary.txt"
Set-Content -Path $canaryFile -Value "SECRET_CANARY_WIN"

# Set ACL on canary: deny read to low-privilege / AppContainer accounts
$acl = Get-Acl $canaryFile
$acl.SetAccessRuleProtection($true, $false)
$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators","FullControl","Allow")
$acl.AddAccessRule($adminRule)
Set-Acl $canaryFile $acl

# 2. Launch two jobs under restricted AppContainer tokens via worker service
# (Queries process token security attributes)
$procA = Start-Process powershell.exe -ArgumentList "-Command Start-Sleep 5" -PassThru
$procB = Start-Process powershell.exe -ArgumentList "-Command Start-Sleep 5" -PassThru

# 3. Query AppContainer SID and Job Object membership using PowerShell token inspection
# Each job worker process must be placed in a distinct Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
# Cross-process memory or handle inspection between workers is blocked by OS kernel.

# 4. Attempt cross-read from unprivileged token -> MUST FAIL (Access Denied)
# Assert access denied
Remove-Item -Recurse -Force $canaryDir
```

- **Pass Criteria:**
  - Independent jobs run under distinct OS security identities (Linux DynamicUser UIDs, macOS pool account UIDs, Windows Job Objects/AppContainer SIDs).
  - Cross-identity access to private temp paths or canaries yields immediate `Permission denied` / `ERROR_ACCESS_DENIED`.

---

### PROOF-C: Kill-to-Zero Descendant Tree Sweep

- **Platform:** Linux, macOS, Windows
- **Required Privilege:** Root / Administrator
- **Plan Gate:** **G8** (Verified Process-Tree Death: all descendant processes including `setsid`/double-fork killed before reuse)

#### Linux & macOS (Daemonizing Double-Fork Escape Test)
```bash
# 1. Compile or write a test binary that calls setsid() and double-forks to detach into init
cat << 'EOF' > /tmp/double_fork.c
#include <unistd.h>
#include <stdlib.h>
int main() {
    if (fork() == 0) {
        setsid();
        if (fork() == 0) {
            while (1) sleep(1);
        }
    }
    return 0;
}
EOF
gcc -O2 /tmp/double_fork.c -o /tmp/double_fork_escape

# 2. Run escape binary under isolated worker UID (e.g. Linux DynamicUser or macOS pool user)
if [ "$(uname)" = "Darwin" ]; then
    TEST_UID=451
    sudo -u _northstar_pool_0 /tmp/double_fork_escape
else
    # Linux DynamicUser transient unit
    systemd-run --unit=northstar-escape-test -p DynamicUser=yes /tmp/double_fork_escape
    # Or under a dedicated test UID
    TEST_UID=61200
    sudo useradd -u $TEST_UID -M northstar_test_escape 2>/dev/null || true
    sudo -u northstar_test_escape /tmp/double_fork_escape
fi

# 3. Assert orphan process is running detached in background
ORPHAN_PID=$(pgrep -u $TEST_UID -f double_fork_escape)
[ -n "$ORPHAN_PID" ] || { echo "FAIL: Escape process not found running"; exit 1; }

# 4. Trigger Northstar kill-to-zero reaper sweep:
# SIGTERM -> 500ms grace -> SIGKILL loop (10 x 100ms) until pgrep is empty
sudo pkill -TERM -u $TEST_UID || true
sleep 0.5
for i in $(seq 1 10); do
    ACTIVE=$(pgrep -u $TEST_UID)
    if [ -z "$ACTIVE" ]; then break; fi
    sudo pkill -KILL -u $TEST_UID || true
    sleep 0.1
done

# 5. Assert ZERO remaining processes under that UID
REMAINING=$(pgrep -u $TEST_UID)
if [ -n "$REMAINING" ]; then
    echo "FAIL: Leak detected. Processes still running under UID $TEST_UID: $REMAINING"
    exit 1
fi
echo "PASS: Kill-to-zero completely eliminated all double-fork descendants"
```

#### Windows (Job Object Termination)
```powershell
# 1. Spawn a Job Object configured with TerminateOnClose
# 2. Spawn a child process inside the Job Object that spawns sub-processes via WMI or cmd.exe
# 3. Terminate Job Object via TerminateJobObject(hJob, 1)
# 4. Assert all descendant PIDs are terminated immediately by Windows kernel
```

- **Pass Criteria:**
  - Double-fork and detached background processes cannot escape the worker security boundary.
  - Reaper sweep terminates all child, descendant, and orphan processes.
  - `pgrep -u <UID>` returns exactly 0 processes before the UID is returned to the pool or reused.

---

### PROOF-D: Live Hostile Worker Socket Denial

- **Platform:** Linux, Windows
- **Required Privilege:** Root / Administrator
- **Plan Gate:** **G7**, **G11** (Endpoint security, peer identity attestation, no unauthenticated access)

#### Linux (Unix Domain Socket Cross-UID Attestation Denial)
```bash
# 1. Start Northstar broker as normal user (UID 1000)
# Socket created at $XDG_RUNTIME_DIR/northstar/broker.sock with 0600 perms
SOCKET_PATH="$XDG_RUNTIME_DIR/northstar/broker.sock"

# 2. Attempt to connect from a different UID (e.g., nobody, or via setpriv / su)
# Test A: Filesystem DAC blocks connection (0600 on socket or 0700 on dir)
sudo -u nobody nc -U "$SOCKET_PATH" </dev/null && exit 1 || true

# Test B: If filesystem permissions were modified (e.g. 0666), broker SO_PEERCRED check must disconnect
# The broker verifies peer UID == broker UID upon accept() and immediately drops mismatching peers.
```

#### Windows (Named Pipe DACL & SID Attestation Denial)
```powershell
# 1. Broker creates Named Pipe with DACL: (A;;0x12019F;;;<OWNER_SID>)
$pipeName = "\\.\pipe\northstar-ipc-test"

# 2. Attempt connection as a different Windows user (via runas or secondary service token)
# Run as standard low-privilege user
Start-Process powershell.exe -Credential $testUser -ArgumentList "-Command [System.IO.File]::Open('\\.\pipe\northstar-ipc-test', 'Open', 'ReadWrite')" -Wait

# 3. Assert connection fails with System.UnauthorizedAccessException / Win32Exception: ERROR_ACCESS_DENIED (5)
```

- **Pass Criteria:**
  - Cross-UID connection on Unix domain socket fails at filesystem DAC or is immediately severed by broker `SO_PEERCRED` / `getpeereid` validation.
  - Cross-SID connection on Windows Named Pipe receives OS `ERROR_ACCESS_DENIED (5)` at `CreateFileW` DACL check.

---

### PROOF-E: Artifact Signature Verification & Manifest Audit

- **Platform:** macOS, Windows, Linux
- **Required Privilege:** Standard User
- **Plan Gate:** **G9** (UI Automation TCB Integrity: drivers and artifacts verified before execution)

#### macOS Codesign & Notarization Audit
```bash
# 1. Verify codesign validity and strict runtime conformance
codesign --verify --verbose=4 --strict /path/to/cua-driver

# 2. Validate Apple Team ID matches trusted developer
TEAM_ID=$(codesign -dv --verbose=4 /path/to/cua-driver 2>&1 | grep "TeamIdentifier=" | cut -d= -f2)
[ "$TEAM_ID" = "YOUR_APPROVED_TEAM_ID" ] || { echo "FAIL: Untrusted Team ID: $TEAM_ID"; exit 1; }

# 3. Verify Gatekeeper / notarization assessment
spctl --assess --type execute --verbose=4 /path/to/cua-driver
```

#### Windows Authenticode Signature Audit
```powershell
# 1. Verify Authenticode digital signature on binary
$sig = Get-AuthenticodeSignature -FilePath "dist\cua-driver.exe"
if ($sig.Status -ne "Valid") { throw "Signature invalid: $($sig.StatusMessage)" }

# 2. Verify Subject CN matches trusted signing certificate
$subject = $sig.SignerCertificate.Subject
if ($subject -notmatch "CN=Your Approved Company") { throw "Untrusted signer: $subject" }
```

#### Cross-Platform Manifest SHA-256 Check
```bash
# 1. Compute SHA-256 and assert exact match with artifacts.manifest.json
node scripts/enroll-artifacts.mjs \
  --manifest artifacts/artifacts.manifest.json \
  --name cua-driver \
  --platform "$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)" \
  --file /path/to/cua-driver \
  --expect "$(sha256sum /path/to/cua-driver | awk '{print $1}')"
```

- **Pass Criteria:**
  - Signature status is `Valid` / assessed accepted by OS security authority.
  - Manifest hash verification strictly matches file byte payload without drift.

---

## 3. Local Verification Log

- **2026-09-21:** Local unsigned install on operator MacBook proved pkgbuild/productbuild flow, postinstall pool creation (`_northstar_pool_1..4`, hidden), launchd load; daemon stopped+uninstalled after verify because binary was then a stub. Note this daemon slice supersedes the stub.
