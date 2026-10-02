# Coucou × opencode

Gives [opencode](https://opencode.ai) its own pill in the notch, next to Claude Code.

No changes to the Coucou app are needed. Coucou already accepts any tool that writes
newline-delimited JSON with a `coucou_agent` field — see [`docs/AGENTS.md`](../../docs/AGENTS.md).
This is a ~160-line opencode plugin that translates opencode's plugin events into that
payload and writes them to Coucou's Unix socket.

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

## No approvals

Coucou's Allow/Deny card is **Claude Code only**, and that is a limitation on both
sides:

- `docs/AGENTS.md` states `PermissionRequest` is not implemented for third-party
  agents — Coucou answers immediately with no decision.
- opencode exposes `permission.asked` / `permission.replied` as *events*. An event
  can observe a permission request but cannot answer it, so there is no way for a
  plugin to hold the request open while the user clicks a button.

So you get live session display, tool-by-tool progress, completion and error states.
Permission prompts stay in the terminal. `tool.execute.before` can block by throwing,
but throwing only denies — there is no "wait for a human, then allow".

## Fail-safe behaviour

The plugin is strictly fire-and-forget, on the principle that a notch toy must never
slow down or break a coding session:

- If Coucou is not running the socket is absent and `send()` returns immediately.
- Connection errors are swallowed — Coucou quitting mid-session is normal.
- A 2-second socket timeout bounds the worst case if the app is wedged.
- Nothing is ever awaited, so no opencode event waits on the notch.

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
