# Kiro Session Data Transfer Guide

## What you need to do on the other laptop

Copy the Kiro session data folder so it can be merged into the inspector
dashboard on your main machine.

---

## Step 1: Locate the data folder

The folder path depends on the OS of the other laptop:

| OS      | Path                                                                                  |
|---------|---------------------------------------------------------------------------------------|
| Windows | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\`                                   |
| macOS   | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`               |
| Linux   | `~/.config/Kiro/User/globalStorage/kiro.kiroagent/`                                   |

To confirm you have the right folder, look inside it for:
- A `workspace-sessions/` directory (contains session metadata)
- Multiple 32-character hex-named directories (contain execution data)

---

## Step 2: Copy the folder

Copy the **entire `kiro.kiroagent/` folder** to a USB drive, OneDrive,
or any transfer method you prefer.

You only need these subdirectories:
- `workspace-sessions/` — all contents
- Every `[32-char-hex]/` directory — all contents

You can skip these (not needed for the dashboard):
- `index/`
- `dev_data/`
- `default/`
- `out/`
- `.diffs/`, `.migrations/`, `.utils/`

---

## Step 3: Place it on your main machine

Put the copied folder somewhere on your main machine. Suggested location:

```
C:\Users\<you>\Documents\KiroData-Workspace\
```

The internal structure should look like:

```
KiroData-Workspace\
  workspace-sessions\
    {base64url-encoded-folder-names}\
      sessions.json
      {sessionId}.json
      ...
  {32-char-hex}\
    {index-file}
    {session-hash}\
      {execution-files}
  ...
```

---

## Step 4: Tell me the path

Once you've placed the folder on this machine, come back and tell me the
path (e.g. `C:\Users\<you>\Documents\KiroData-Workspace`).

I'll then update the inspector server to read from both locations and
merge the data into one unified dashboard showing total time across both
machines.

---

## What gets merged

- **Total time** — combined across both machines
- **Sessions** — all sessions from both machines appear in the sidebar
- **Daily/weekly charts** — unified timeline
- **Top workspaces** — merged (same workspace name from different machines
  gets combined)

---

## Quick verification (optional)

Before copying, you can check how much data is there by running this on
the other laptop:

**Windows (PowerShell):**
```powershell
$p = Join-Path $env:APPDATA 'Kiro\User\globalStorage\kiro.kiroagent'
Write-Host "Path: $p"
Write-Host "Exists: $(Test-Path $p)"
$ws = Join-Path $p 'workspace-sessions'
Write-Host "Workspaces: $((Get-ChildItem $ws -Directory).Count)"
Write-Host "Total size: $([math]::Round((Get-ChildItem $p -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)) MB"
```

**macOS/Linux (bash):**
```bash
p="$HOME/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent"
echo "Path: $p"
echo "Exists: $(test -d "$p" && echo yes || echo no)"
echo "Workspaces: $(ls "$p/workspace-sessions" | wc -l)"
echo "Total size: $(du -sh "$p" | cut -f1)"
```
