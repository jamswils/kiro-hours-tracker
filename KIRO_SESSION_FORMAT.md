# Kiro IDE Session Storage Format

## Overview

Kiro IDE stores session data across multiple locations and formats. The chat history visible in the IDE is reconstructed from two separate data sources: session metadata and execution files.

## Storage Locations

Base path: `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`

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
[{ "sessionId": "uuid", "title": "...", "dateCreated": "timestamp" }]
```

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
  "usageSummary": {...},
  "contextUsagePercentage": 45.2
}
```

### 3. `.chat` Files (Legacy/Alternative Format)

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
