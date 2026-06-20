# Architecture

Voice Router delivers a [Hex](https://github.com/kitlangton/Hex) voice transcript to the
right Claude Code agent pane in [herdr](https://herdr.dev), chosen by the **browser tab you
were looking at when you spoke** — so you never have to manually focus the correct pane.

## The problem

You run many Claude Code instances across herdr worktrees. When you dictate with Hex, the
text lands wherever the OS cursor is — forcing you to first focus the right pane. Voice
Router removes that step: it watches what you transcribe and routes it to the agent that
matches your current browser context.

## Moving parts

| Component | Tech | Role |
|---|---|---|
| **Hex** | macOS app (external) | Voice→text. Writes each transcript to `transcription_history.json` in its sandbox container. We only *read* this file. |
| **Chrome extension** | MV3 (TypeScript→esbuild) | A *sensor*: streams the active tab's URL + window-focus state to the daemon, holds user settings, shows status. Makes **no routing decisions**. |
| **voicerouter daemon** | Node (TypeScript→esbuild), launchd agent | The *brain*: watches Hex's file, matches each new transcript to a URL + routing rule, and delivers it via the herdr CLI. |
| **herdr** | CLI multiplexer (external) | Hosts the workspaces/tabs/panes where Claude Code agents run. Driven over its local unix socket. |

### Why this split

The extension is sandboxed — it **cannot read files or run CLIs** — so the real work must
live in a local process. The daemon is also the only component that observes Hex. Keeping
the extension "dumb" is deliberate: the MV3 service worker is evicted frequently, so no
decision logic or state is stranded there. See the data-flow note below.

## System flow

```mermaid
flowchart TB
    U(["You: speak / switch tabs / set rules"])

    subgraph chrome["Google Chrome (sandboxed)"]
        direction TB
        EXT_POP["popup + options<br/>focus toggle · routes editor"]
        STORE[("chrome.storage.local<br/>settings")]
        EXT_CS["content script (optional)<br/>⌘-double / Esc hints"]
        EXT_BG["background service worker<br/>tracks active tab + window focus"]
    end

    subgraph hex["Hex — voice-to-text"]
        HEXAPP["Hex app"]
        HEXJSON[("transcription_history.json<br/>(sandbox container)")]
    end

    subgraph daemon["voicerouter daemon — Node + launchd"]
        direction TB
        HTTP["HTTP API · 127.0.0.1:8137"]
        STATE[["URL timeline · focus timeline · config"]]
        WATCH["fs.watch on Hex file"]
        ROUTE["route(): match URL → focus gate →<br/>matchRoute(config) → resolveTarget"]
    end

    subgraph herdr["herdr — CLI multiplexer"]
        WS["workspace fix-rwr-1234-…<br/>tab 'main' → pane 'agent'"]
        AGENT([Claude Code agent])
    end

    U -->|"⌘⌘ + speak"| HEXAPP
    HEXAPP -->|writes| HEXJSON
    U -->|tab switch / focus| EXT_BG
    EXT_POP <-->|"read / write"| STORE
    STORE -.->|onChanged| EXT_BG
    EXT_CS -.->|gesture msg| EXT_BG
    EXT_BG -->|"POST /active-url · /focus · /config"| HTTP
    HTTP --> STATE
    HEXJSON -->|new entry| WATCH
    WATCH --> ROUTE
    STATE --> ROUTE
    ROUTE -->|"herdr pane send-text + Enter<br/>(via unix socket)"| WS
    WS --> AGENT
```

## One recording, end to end

```mermaid
sequenceDiagram
    actor User
    participant Hex
    participant Ext as Chrome extension
    participant Daemon
    participant Herdr as herdr CLI
    participant Agent

    Note over Ext,Daemon: continuously, in the background
    User->>Ext: switch to rwr-1234-….payroll.localhost tab
    Ext->>Daemon: POST /active-url {url, ts}
    User->>Ext: focus / blur Chrome
    Ext->>Daemon: POST /focus {focused, ts}

    Note over User,Hex: a recording
    User->>Hex: double-⌘, speak, single-⌘ to stop
    Hex->>Hex: transcribe → append to transcription_history.json

    Daemon->>Daemon: fs.watch fires → diff for new transcript id
    Daemon->>Daemon: pick URL active at recording start (URL timeline)
    Daemon->>Daemon: focus gate — was Chrome focused? (if requireBrowserFocus)
    Daemon->>Daemon: matchRoute(url, config.routes) → workspace key
    Daemon->>Herdr: workspace/tab/pane list → resolve target pane
    Daemon->>Herdr: pane send-text "<transcript>" + send-keys Enter
    Herdr->>Agent: transcript submitted as an instruction
```

## How routing is decided (all daemon-side)

For each new transcript the daemon, in `route()` / `deliverToHerdr()`:

1. **Attribute a URL** — the tab active during the recording window, from the URL timeline
   (anchored at recording *start*; duration/temporal scoring is the fallback matcher).
2. **Focus gate** — if `requireBrowserFocus`, skip unless Chrome was focused at that moment
   (from the focus timeline).
3. **Match a rule** — first `config.routes` entry whose `urlPattern` matches; `{workspace}`
   captures the herdr workspace key (e.g. `rwr-1234-heardroom`).
4. **Resolve the pane** — find the herdr workspace (label/worktree, tolerant of a `fix-`
   prefix) → tab `tabName` → pane `paneName`.
5. **Deliver** — `herdr pane send-text` + `send-keys Enter` into that pane.

URLs matching no rule, or recordings made while unfocused (when gated), are dropped.

## Interfaces

**Hex store** (read-only, live-verified):
`~/Library/Containers/com.kitlangton.Hex/Data/Library/Application Support/com.kitlangton.Hex/transcription_history.json`
— JSON `{ history: [{ id, timestamp (Apple-epoch s), text, duration, audioPath, … }] }`.

**Daemon HTTP API** (`127.0.0.1:8137`, loopback only):

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, transcript count, current URL, focus, config, last match |
| POST | `/active-url` | extension → URL timeline |
| POST | `/focus` | extension → focus timeline |
| POST | `/config` | extension → settings (Zod-validated; 400 on bad input) |
| POST | `/recording` | optional gesture hints (start/finish/abort) |
| POST | `/match` | debug: best transcript for an explicit time window |
| POST | `/route-test` | debug: run gate→resolve→deliver for a URL (dry-run by default) |
| GET | `/transcripts/latest` | debug peek |

**chrome.storage.local** — `settings: { requireBrowserFocus, routes[] }`. The extension is
the source of truth; it pushes to `/config` on startup, on change, and each health tick.

**herdr** — controlled via the `herdr` CLI over `~/.config/herdr/herdr.sock` (works from
outside herdr because every call targets explicit ids).

## Config & schema

The config exchanged between extension and daemon is validated by a **shared Zod schema**
(`shared/config-schema.ts`) — `ConfigSchema` / `RouteSchema`, with inferred TS types — so
both sides agree on shape. Fields are optional to preserve the daemon's partial-merge.
Defaults differ intentionally by call site: daemon `requireBrowserFocus=false` (permissive
until the extension syncs), extension default `true`.

## Build & deploy

- **TypeScript** everywhere; `tsc --noEmit` type-checks (base + per-target leaf configs).
- **esbuild** bundles both sides (Zod inlined, no runtime `node_modules`): daemon →
  `daemon/dist/server.js` (node/cjs); extension → `extension/dist/*.js` (browser/iife).
- **`install.sh`** runs `npm install && npm run build`, then installs the daemon as a
  **launchd LaunchAgent** (`RunAtLoad` + `KeepAlive`, absolute node/herdr paths baked in).
- The **extension** is loaded unpacked from `extension/` (references `dist/*.js`).

## Source map

```
shared/config-schema.ts     Zod schema shared by both sides
daemon/src/
  server.ts                 HTTP API, timelines, watcher, route(), boot
  hex.ts                    read/normalize transcription_history.json
  matcher.ts                URL-for-transcript + explicit-window matchers
  herdr.ts                  CLI wrapper, URL-pattern compiler, workspace/tab/pane resolve
  config.ts                 ports, paths, tunables
extension/src/
  background.ts             URL/focus streaming, config sync, health badge
  content.ts                optional ⌘-double / Esc gesture detection
  popup.ts / options.ts     status + focus toggle / routes editor
build.mjs · tsconfig*.json · install.sh · uninstall.sh
```
