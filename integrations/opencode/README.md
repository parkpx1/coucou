# Coucou × opencode

Gives [opencode](https://opencode.ai) its own pill in the notch, next to Claude
Code — including **Allow / Deny straight from the notch**.

Session display needs no app changes: Coucou already accepts any tool that writes
newline-delimited JSON with a `coucou_agent` field — see
[`docs/AGENTS.md`](../../docs/AGENTS.md). Approvals do need a small app patch, which
is on this branch and described below.

## Install

Copy the plugin into either plugin directory:

```sh
# global — every project
mkdir -p ~/.config/opencode/plugins
cp coucou-opencode.ts ~/.config/opencode/plugins/

# or per project
mkdir -p .opencode/plugins
cp coucou-opencode.ts .opencode/plugins/
```

opencode loads files in those directories at startup. Restart opencode, and the pill
appears on the first tool call.

For approvals you also need a Coucou build from this branch — the released app
still declines to show a card for third-party agents.

Nothing else to configure: no API key, no settings file edit, no hook installation.
Unlike the Claude Code integration, this does not touch `~/.claude/settings.json`.

## Event mapping

| opencode | Coucou | Pill effect |
|---|---|---|
| `session.created` | `SessionStart` | creates the pill |
| `message.updated` (role `user`) | `UserPromptSubmit` | → thinking |
| `tool.execute.before` | `PreToolUse` | → working, tool name in ticker |
| `tool.execute.after` | `PostToolUse` | → working |
| `session.idle` | `Stop` | → finished for 5 s, then removed |
| `session.error` | `StopFailure` | → error |
| `session.deleted` | `SessionEnd` | pill removed |

Two details worth knowing:

- **Assistant messages are ignored.** `message.updated` fires for both roles and
  streams continuously; forwarding assistant updates would reset the pill to
  "thinking" on every token.
- **`SessionStart` is emitted lazily, once.** opencode does not guarantee
  `session.created` fires before the first tool call, so any event will create the
  pill if it does not exist yet.

## Approvals from the notch

**Works.** This required a small patch to the Coucou app, included on this branch.

Two things had to be true, and both turned out to be:

1. **opencode can block.** `permission.ask` is a *hook*, not just an event: it
   returns a `Promise` that opencode awaits, and takes a mutable
   `output.status: "ask" | "deny" | "allow"`. So the plugin can hold the permission
   open on the socket and set the status when you click. Verified: with a fake
   Coucou replying after 1500 ms, the hook waited 1503 ms and then applied `allow`.
   (The earlier `permission.asked` / `permission.replied` *events* cannot do this —
   they only observe.)

2. **Coucou's approval machinery is agent-agnostic.** `processPermissionRequest`
   already holds the fd open and replies with whatever you click. It was gated by
   an explicit early return for external agents, and three hardcoded
   `integration_claude` pill ids.

### App patch

| Change | Why |
|---|---|
| Removed the external-agent early return | It replied `ask` immediately, so the card never appeared |
| VS Code filter now applies to Claude Code only | External agents carry their own pill, matching what `processEvent` already does |
| Card routes to `agent_<name>` | Previously always the Claude pill, so an opencode request looked like a Claude one |
| Added `pendingApprovalAgentId` | The decision reset the Claude pill regardless of who asked |

Upstream's `docs/AGENTS.md` says approval support "will be added with Codex
support", so this may land upstream eventually and make the patch redundant.

### Decision mapping

| Notch button | opencode result |
|---|---|
| Allow | `allow` |
| Always | `allow` — **this request only** |
| Deny | `deny` |
| Dismissed, timeout, or Coucou not running | untouched → opencode prompts in the terminal |

**"Always" does not persist.** Claude Code's relay returns `updatedPermissions` so
the rule is saved; opencode has no plugin-side equivalent, so Always behaves like
Allow for this one request. The pattern is still sent as `permission_suggestions`
in case that changes.

The plugin's timeout is 115 s, just under the app's own auto-`ask`, so opencode
regains control first rather than both sides expiring.

## Fail-safe behaviour

The plugin is strictly fire-and-forget, on the principle that a notch toy must never
slow down or break a coding session:

- If Coucou is not running the socket is absent and `send()` returns immediately.
- Connection errors are swallowed — Coucou quitting mid-session is normal.
- A 2-second socket timeout bounds the worst case if the app is wedged.
- Nothing is ever awaited **except** `permission.ask`, where waiting is the point.
  That one path still falls back to opencode's own prompt on timeout or error.

Measured with no socket present: 150 events in ~1 ms, no exceptions. Same with a
stale socket file left behind by a crash.

## Socket paths

Probed in this order, per connection rather than cached, so the plugin survives
Coucou being installed or swapped mid-session:

| Build | Path |
|---|---|
| GitHub release | `~/Library/Application Support/NotchBuddy/nb.sock` |
| App Store (sandboxed) | `~/Library/Containers/fr.louisraille.Coucou/Data/nb.sock` |

## Windows

Not supported yet. Coucou's Windows build uses a named pipe
(`\\.\pipe\coucou-<user-SID>`) rather than a Unix socket, so `send()` would need a
platform branch. The event mapping above would carry over unchanged.

## Testing without Coucou installed

The plugin can be exercised against a fake socket server — listen on the GitHub-build
path, call the exported hooks directly, and assert on the JSON received. That is how
the event mapping and the fail-safe behaviour above were verified.
