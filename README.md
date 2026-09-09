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

- Node 20.19+ or 22.12+ (Vite 8's floor). CI builds on Node 22.
- pnpm — do not substitute npm. `packageManager` in `package.json` pins
  `pnpm@9.15.9`, so `corepack enable` activates the right version
  automatically; `corepack pnpm <cmd>` works without a global install.

### Install and run

```bash
corepack enable     # once per machine
pnpm install
pnpm start
```

pnpm is the package manager for this repo. The one place `npx` appears is
inside the `server` and `start` scripts (`npx tsx server/index.ts`) — there it
is only resolving the locally installed `tsx` binary to run the TypeScript
backend without a build step, not managing dependencies. Install with `pnpm`
only: `npm install` would generate a second lockfile and drift from
`pnpm-lock.yaml`.

`pnpm start` uses [`concurrently`](https://www.npmjs.com/package/concurrently)
to launch two processes:

| Script        | What it does                                              | Port |
| ------------- | --------------------------------------------------------- | ---- |
| `pnpm dev`    | Vite dev server for the React UI with HMR                 | 5173 |
| `pnpm server` | Express API (`server/index.ts`) that streams session JSON | 3001 |

Open <http://localhost:5173> once both are running. The Vite dev server proxies
`/api` to `http://127.0.0.1:3001`, so the browser stays same-origin and no CORS
headers are involved on the normal path.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Backend bind address. **Loopback only by default** — API responses contain full session transcripts and tool output, including command output from your machine. Only set this if you genuinely intend to expose that data beyond localhost. |
| `PORT` | `3001` | Backend port. Change it and you must update the `/api` proxy target in `vite.config.ts` to match. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowlist, only consulted when the UI is served from a different origin than the API. Never a wildcard, deliberately — see the comment in `server/index.ts`. |
| `KIRO_GLOBAL_STORAGE` | platform default | Absolute path to a `kiro.kiroagent/` directory, overriding platform detection. |
| `KIRO_EXTRA_SOURCES` | _(empty)_ | `;`-separated extra data roots merged into the dashboard scan — used for session data copied from another machine (see [`TRANSFER-GUIDE.md`](TRANSFER-GUIDE.md)). |

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
  index.ts              # Express API; resolves the Kiro storage dir per platform
```

### Data sources

The Express backend reads directly from local disk. The base directory is
resolved per platform (`resolveGlobalStorage()` in `server/index.ts`):

| Platform | Base directory |
| --- | --- |
| macOS | `~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/` |
| Windows | `%APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\` |
| Linux / other | `~/.config/Kiro/User/globalStorage/kiro.kiroagent/` |

Inside whichever base applies:

```
workspace-sessions/           # per-workspace session metadata (sessions.json, <sessionId>.json)
<sha256[:32](workspace)>/...  # per-execution JSON files with tool calls and usage
```

**Linux support, honestly:** the Linux path is the `default:` branch of a
platform switch — the conventional XDG location, not a path validated against a
Linux Kiro install. It is a fallback, not a tested guarantee. If your install
puts the data elsewhere, point `KIRO_GLOBAL_STORAGE` at the
`kiro.kiroagent/` directory and platform detection is bypassed entirely. The
same applies to reading data copied from another machine.

No credentials are sent off-machine; everything stays on local disk.

### Data stores

The backend can read more than one on-disk layout. Selection is by
environment variable:

| Variable | Values | Meaning |
| --- | --- | --- |
| `KIRO_STORE` | `kiro` \| `kirocrew` \| `auto` | Which store to read. `kiro` is the Kiro IDE layout documented in [`KIRO_SESSION_FORMAT.md`](KIRO_SESSION_FORMAT.md); `kirocrew` is the KiroCrew store; `auto` detects which is present. |
| `KIROCREW_DATA_HOME` | path | Root of the KiroCrew data directory, used when the KiroCrew store is active. |

Paths and platform detection described above apply to the Kiro IDE store;
`KIROCREW_DATA_HOME` locates the KiroCrew store independently.

### Build a production bundle

```bash
pnpm build        # emits ./dist
pnpm preview      # serves ./dist on http://localhost:4173
```

In production you still need `pnpm server` running (or the Express code
ported behind whatever reverse proxy you prefer) so the UI can fetch
session data.

### Linting and type checking

```bash
pnpm lint         # ESLint over src/, server/, scripts/ and eslint.config.js
pnpm typecheck    # tsc -p tsconfig.server.json (backend) && tsc -b (app + vite config)
```

ESLint is configured in `eslint.config.js` with TypeScript + React hooks rules.
`src/**` gets browser globals; `server/**` gets node globals and no React
plugins; `scripts/**/*.mjs` and the config file itself are linted as plain
node JS. Type-aware linting is not enabled — type checking lives in the
`typecheck` script instead. Prettier is not currently wired up.

The backend is executed by `tsx` and never emitted, so it has its own
`noEmit` project (`tsconfig.server.json`, `strict: true`) rather than sitting in
the `tsc -b` build graph.

`.github/workflows/web-ci.yml` runs lint, typecheck, build and test on every
push and pull request. Lint is `continue-on-error` while a pre-existing backlog
of findings is worked down: the step still runs and reports, but does not block
the build.

---

## macOS native version (SwiftUI)

A fully offline port with no Express backend — the Swift app reads the
same JSON files and hashed workspace directories directly.

The two front-ends are not at feature parity: the native app's dashboard shows
credits, session and execution counts and spend breakdowns, but none of the
hours/time metrics (active vs raw duration, the aborted-execution clamp, daily
hour totals) that the web dashboard computes. The web app is the
full-featured surface; use the native app for cost and session volume.

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
