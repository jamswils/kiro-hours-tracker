# Kiro Sessions Inspector

Inspect the sessions and tool executions recorded by the Kiro IDE directly
from your local Application Support folder. Two front-ends are shipped in
this repo:

- **Web** — React + Vite app with a small Express backend that reads the
  session JSON files. Runs in a browser.
- **macOS native** — SwiftUI port of the same UI, packaged as a `.app`
  bundle with its own Dock icon. No server required.

Both read the same on-disk format documented in
[`KIRO_SESSION_FORMAT.md`](KIRO_SESSION_FORMAT.md).

---

## Web version (React + Express)

### Requirements

- Node 20+
- [pnpm](https://pnpm.io/) (installed via `corepack enable` or `brew install pnpm`)

### Install and run

```bash
pnpm install
pnpm start
```

`pnpm start` uses [`concurrently`](https://www.npmjs.com/package/concurrently)
to launch two processes:

| Script        | What it does                                              | Port |
| ------------- | --------------------------------------------------------- | ---- |
| `pnpm dev`    | Vite dev server for the React UI with HMR                 | 5173 |
| `pnpm server` | Express API (`server/index.ts`) that streams session JSON | 3000 |

Open <http://localhost:5173> once both are running.

### Layout

```
src/
  App.tsx               # top-level routing
  main.tsx              # React entry
  components/
    Dashboard.tsx       # aggregate stats, charts, breakdowns
    SessionView.tsx     # message thread with expandable tool calls
    Sidebar.tsx         # workspace + session list
server/
  index.ts              # Express API reading ~/Library/Application Support/Kiro
```

### Data sources

The Express backend reads directly from:

```
~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/
  workspace-sessions/           # per-workspace session metadata (sessions.json, <sessionId>.json)
  <sha256[:32](workspace)>/...  # per-execution JSON files with tool calls and usage
```

No credentials are sent off-machine; everything stays on local disk.

### Build a production bundle

```bash
pnpm build        # emits ./dist
pnpm preview      # serves ./dist on http://localhost:4173
```

In production you still need `pnpm server` running (or the Express code
ported behind whatever reverse proxy you prefer) so the UI can fetch
session data.

### Linting

```bash
pnpm lint
```

ESLint is configured in `eslint.config.js` with TypeScript + React hooks
rules. Prettier is not currently wired up.

---

## macOS native version (SwiftUI)

A fully offline port with no Express backend — the Swift app reads the
same JSON files and hashed workspace directories directly.

See [`macos-swift/README.md`](macos-swift/README.md) for the quick start,
[`macos-swift/HOMEBREW.md`](macos-swift/HOMEBREW.md) for Homebrew install,
and [`macos-swift/DISTRIBUTION.md`](macos-swift/DISTRIBUTION.md) for
building a shareable `.dmg` or `.zip`.

```bash
cd macos-swift
swift run                 # dev run
make dmg                  # release .dmg in .build/dist/
```

---

## License

[MIT-0](LICENSE) (MIT No Attribution) — use it however you like.
