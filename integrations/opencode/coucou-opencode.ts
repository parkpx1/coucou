/**
 * Coucou plugin for opencode.
 *
 * Bridges opencode's plugin events to Coucou's external-agent socket API
 * (docs/AGENTS.md), so opencode sessions get their own pill in the notch
 * alongside Claude Code.
 *
 * No changes to the Coucou app are required: it already accepts any agent that
 * writes newline-delimited JSON carrying a `coucou_agent` field.
 *
 * Install: see integrations/opencode/README.md
 */

import net from "node:net"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

/** Must match ^[a-z0-9-]{1,24}$ and not be "claude", or Coucou routes events to the Claude pill. */
const AGENT = "opencode"

/**
 * Candidate socket paths, in the order Coucou's own docs list them. The GitHub
 * build writes to Application Support; the App Store build is sandboxed and
 * writes inside its container. Probed per connection rather than cached once, so
 * the plugin survives Coucou being installed, swapped or restarted mid-session.
 */
const SOCKET_PATHS = [
  path.join(os.homedir(), "Library/Application Support/NotchBuddy/nb.sock"),
  path.join(os.homedir(), "Library/Containers/fr.louisraille.Coucou/Data/nb.sock"),
]

const findSocket = (): string | null =>
  SOCKET_PATHS.find((p) => {
    try {
      return fs.statSync(p).isSocket()
    } catch {
      return null
    }
  }) ?? null

/**
 * Fire-and-forget a single event.
 *
 * Deliberately silent and non-blocking: a notch toy must never slow down or
 * break a coding session. If Coucou is not running the socket is absent and we
 * return immediately, which mirrors how Coucou's own Claude Code relay exits
 * when the app is closed.
 */
function send(payload: Record<string, unknown>): void {
  const socketPath = findSocket()
  if (!socketPath) return

  let settled = false
  const done = (sock?: net.Socket) => {
    if (settled) return
    settled = true
    sock?.destroy()
  }

  try {
    const sock = net.createConnection(socketPath)
    // The app is local; anything slower than this means it is wedged.
    sock.setTimeout(2000)
    sock.on("timeout", () => done(sock))
    // Never surface a connection error: Coucou quitting mid-session is normal.
    sock.on("error", () => done(sock))
    sock.on("connect", () => {
      sock.write(JSON.stringify(payload) + "\n", () => done(sock))
    })
  } catch {
    // ignore
  }
}

/** Fields Coucou reads on every event (see HookServer.processEvent). */
function base(event: string, sessionId: string, directory: string) {
  return {
    hook_event_name: event,
    coucou_agent: AGENT,
    session_id: sessionId || "opencode",
    cwd: directory,
    // Coucou filters Claude Code events to VS Code terminals, but external
    // agents bypass that check. Passed through anyway so the session's terminal
    // is identifiable in Coucou's log.
    term_program: process.env.TERM_PROGRAM ?? "",
    bundle_id: process.env.__CFBundleIdentifier ?? "",
  }
}

export const CoucouPlugin = async ({ directory, worktree }: any) => {
  const cwd = worktree || directory || process.cwd()
  // opencode has no single "session id" on every event, so sessions are keyed by
  // the event payload when present and fall back to a per-process id. Coucou only
  // uses this to group a pill's events, so stability matters more than the value.
  const fallbackSession = `opencode-${process.pid}`
  let started = false

  /** Coucou creates the pill on SessionStart; emit it once, lazily. */
  const ensureSession = (sessionId: string) => {
    if (started) return
    started = true
    send(base("SessionStart", sessionId, cwd))
  }

  return {
    /**
     * Tool lifecycle. PreToolUse drives the "working" state and the ticker label,
     * so the tool name is what the user actually sees in the notch.
     */
    "tool.execute.before": async (input: any) => {
      const id = input?.sessionID ?? fallbackSession
      ensureSession(id)
      send({
        ...base("PreToolUse", id, cwd),
        tool_name: input?.tool ?? "Tool",
        // Coucou renders a short label from tool_input; it is not required.
        tool_input: {},
      })
    },

    "tool.execute.after": async (input: any) => {
      const id = input?.sessionID ?? fallbackSession
      ensureSession(id)
      send({
        ...base("PostToolUse", id, cwd),
        tool_name: input?.tool ?? "Tool",
      })
    },

    event: async ({ event }: any) => {
      const id = event?.properties?.sessionID ?? event?.properties?.info?.id ?? fallbackSession

      switch (event?.type) {
        case "session.created":
          ensureSession(id)
          break

        case "message.updated": {
          // Only a user message is a prompt submission; assistant updates stream
          // continuously and would otherwise reset the pill to "thinking".
          const role = event?.properties?.info?.role
          if (role !== "user") return
          ensureSession(id)
          send({ ...base("UserPromptSubmit", id, cwd), prompt: "" })
          break
        }

        case "session.idle":
          // Coucou shows "finished" for 5 s, then removes the pill.
          if (!started) return
          send(base("Stop", id, cwd))
          started = false
          break

        case "session.error":
          if (!started) return
          send({
            ...base("StopFailure", id, cwd),
            message: String(event?.properties?.error?.name ?? "error"),
          })
          started = false
          break

        case "session.deleted":
          if (!started) return
          send(base("SessionEnd", id, cwd))
          started = false
          break
      }
    },
  }
}
