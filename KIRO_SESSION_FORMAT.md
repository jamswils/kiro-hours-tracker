# Kiro IDE Session Storage Format

## Overview

Kiro IDE stores session data across multiple locations and formats. The chat history visible in the IDE is reconstructed from two separate data sources: session metadata and execution files.

## Storage Locations

Base path is platform-dependent. The backend resolves it in
`resolveGlobalStorage()` (`server/index.ts`):

| Platform | Base path |
|---|---|
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` |
| Windows | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\` (falls back to `%USERPROFILE%\AppData\Roaming` when `APPDATA` is unset) |
| Linux / other | `~/.config/Kiro/User/globalStorage/kiro.kiroagent/` |

The `KIRO_GLOBAL_STORAGE` environment variable overrides all three. The Linux
path is the `default:` branch of the platform switch — it is the conventional
XDG location rather than a path verified against a Linux Kiro install, so set
`KIRO_GLOBAL_STORAGE` explicitly if your install differs.

All relative paths below are rooted at whichever base path applies.

### 1. Session Metadata — `workspace-sessions/`

```
workspace-sessions/
  {base64url(workspace_path)}/
    sessions.json              # Index of all sessions for this workspace
    {sessionId}.json           # Individual session file
```

**Directory naming**: The workspace folder name is a base64url-encoded version of the absolute workspace path (e.g., `/Users/angmas/Projects/foo` → `L1VzZXJzL2FuZ21hcy9Qcm9qZWN0cy9mb28_`).

**`sessions.json`** — Array of session summaries:
```json
[{ "sessionId": "uuid", "title": "...", "dateCreated": "1778371200000" }]
```

**`dateCreated` may be a JSON string or a JSON number.** Observed files carry a
UTC-milliseconds value quoted as a string, but readers must not rely on that:
the TypeScript readers coerce with `Number(s.dateCreated)`, which accepts
either. The Swift reader is stricter — `RawSessionSummary.dateCreated` is
declared `String`, so a numeric `dateCreated` fails to decode there. Treat
string-or-number as the contract and coerce on read.

**`{sessionId}.json`** — Full session state:
```json
{
  "history": [
    {
      "message": { "role": "user"|"assistant", "content": "..." | [{type, text}], "id": "..." },
      "executionId": "uuid",        // Links to execution file (assistant messages only)
      "editorState": {...},          // ProseMirror-style editor state
      "contextItems": [...],         // Context sent with the message
      "promptLogs": [...]            // Raw prompts sent to model (minimal)
    }
  ],
  "sessionId": "uuid",
  "title": "...",
  "selectedModel": "claude-sonnet-4.5",
  "defaultModelTitle": "...",
  "autonomyMode": "full"|"supervised",
  "sessionType": "...",
  "contextUsagePercentage": 45.2,
  "workspaceDirectory": "/absolute/path",
  "config": {...}
}
```

**Key insight**: Assistant `message.content` is typically just `"On it."` — the actual work (tool calls, thinking, responses) lives in the execution files.

### 2. Execution Files — `{sha256[:32](workspace_path)}/`

```
{sha256_hash[:32]}/
  {index_hash}                 # Execution index file
  {session_hash}/              # Directory per chat session
    {execution_hash}           # One file per execution
```

**Directory naming**: First 32 characters of `SHA256(absolute_workspace_path)`.

**Execution index file** (the non-directory file in the hash dir):
```json
{
  "executions": [
    { "executionId": "uuid", "type": "chat-agent", "status": "succeed"|"aborted", "startTime": 1778..., "endTime": 1778... }
  ],
  "version": "2.0.0"
}
```

**Execution file** (inside session subdirectory):
```json
{
  "executionId": "uuid",
  "workflowType": "chat-agent",
  "status": "succeed"|"aborted"|"user-aborted",
  "startTime": 1778...,
  "endTime": 1778...,
  "input": {...},
  "autonomyMode": "full",
  "chatSessionId": "uuid",          // Links back to session
  "actions": [...],                  // THE GOOD STUFF — tool calls, thinking, responses
  "context": [...],
  "result": { "status": "...", "executionId": "..." },
  "usageSummary": [                  // ARRAY, not an object — see below
    { "usage": 1.234, "modelId": "claude-sonnet-4.5" }
  ],
  "contextUsagePercentage": 45.2
}
```

**`usageSummary` is an ARRAY.** Every reader requires it: the Express API and
the scan worker both guard with `Array.isArray(...)` and return a cost of `0`
for anything else, and the Swift reader takes `arrayValue`. Credits are the sum
of each element's `usage` field. An object here is silently costed as zero, not
an error.

#### `endTime` lags on aborted executions — clamp it

For `status` of `aborted` or `user-aborted`, Kiro writes `endTime` when the
session is torn down, not when work stopped, so it can overstate the execution
by hours. Any reader computing durations must clamp it. The rule implemented in
`effectiveEnd()` (`server/scan-worker.ts`) is:

1. If `startTime` or `endTime` is missing/zero, use the raw `endTime`.
2. If `status` is neither `aborted` nor `user-aborted`, use the raw `endTime`.
3. Otherwise take the highest `emittedAt` across `actions[]`, add a 60 s grace
   tail (`ABORTED_TAIL_GRACE_MS`), and clamp: `min(rawEnd, lastEmittedAt + 60s)`,
   then floored at `startTime` so the result can never go negative.
4. If no action carries an `emittedAt`, fall back to
   `min(rawEnd, startTime + 60s)`.

The grace tail covers the user reading the reply and hitting stop a few seconds
later. Note the clamp only ever *reduces* the end time — it is a `min` against
the raw value, never an extension. The backend keeps both figures (`end` and
`endRaw`) so the UI can show active vs raw totals side by side.

### 3. `.chat` Files (Legacy/Alternative Format)

> **Not parsed by any implementation in this repo.** Neither the Express
> backend, the scan worker, the `verify-scan` script, nor the Swift app opens
> `.chat` files — a repo-wide search for the extension returns no reader. The
> format is recorded here because the files exist on disk, but no hours, credit
> or session figure in either front-end includes them. Treat this section as
> reference for a future reader, not as a description of current behaviour.

Found in the same hash directories but with `.chat` extension. Simpler format used by some workflows:

```json
{
  "executionId": "uuid",
  "actionId": "act",
  "context": [{ "type": "fileTree", ... }],
  "validations": [...],
  "chat": [
    { "role": "human", "content": "..." },
    { "role": "bot", "content": "..." },
    { "role": "tool", "content": "..." }
  ],
  "metadata": {
    "modelId": "claude-sonnet-4.5",
    "modelProvider": "qdev",
    "workflow": "act",
    "workflowId": "uuid",
    "startTime": 1770...,
    "endTime": 1770...
  }
}
```

## Action Types

The `actions[]` array in execution files contains the full trace of what the agent did:

| actionType | Description | Key Fields |
|---|---|---|
| `intentClassification` | Intent detection (chat/do/spec) | `intentResult` |
| `model` | Raw model call | `endTime` |
| `reasoning` | Thinking/reasoning block | `output.message` |
| `say` | Text response to user | `output.message` |
| `runCommand` | Terminal command execution | `input.command`, `input.cwd`, `output.output`, `output.exitCode` |
| `readFiles` | File read | `input.files[].path` |
| `search` | Workspace search | `input.query`, `input.why` |
| `replace` | File edit (replace content) | `input.file`, `input.originalContent`, `input.modifiedContent` |
| `write` | File write | `input.file`, `input.modifiedContent` |
| `create` | File creation | `input.file`, `input.modifiedContent` |
| `getDiagnostics` | LSP diagnostics check | `input.paths[]` |

### Action Structure

```json
{
  "type": "AgentExecutionAction",
  "executionId": "uuid",
  "actionId": "uuid or tooluse_xxx",
  "actionType": "runCommand",
  "actionState": "Success"|"Accepted"|"Canceled",
  "chatSessionId": "uuid",
  "emittedAt": 1778...,
  "input": { "command": "git status", "cwd": "/path" },
  "output": { "output": "...", "exitCode": 0 }
}
```

## Linking It All Together

```
Session JSON (history[i].executionId)
    ↓
Execution File (found in SHA256[:32](workspacePath) directory)
    ↓
actions[] → reasoning, say, runCommand, readFiles, replace, create, etc.
```

1. Load session from `workspace-sessions/{base64url_path}/{sessionId}.json`
2. Get `workspaceDirectory` from session
3. Compute `SHA256(workspaceDirectory)[:32]` to find execution directory
4. For each `history[].executionId`, find the matching execution file
5. Extract `actions[]` for the full trace of tool calls and thinking

## Other Storage

| Path | Purpose |
|---|---|
| `dev_data/devdata.sqlite` | Token usage tracking (`tokens_generated` table) |
| `index/` | Code search index (`docs.sqlite`, `index.sqlite`, LanceDB) |
| `sessions/` | Unknown (empty or minimal) |
| `default/` | Default configuration |
| `out/` | Build output for MCP servers |

## Content Block Types (in session message.content)

When `message.content` is an array:
- `text` — Plain text
- `imageUrl` — Inline image (base64 data URL)
- `mention` — @-mention reference
