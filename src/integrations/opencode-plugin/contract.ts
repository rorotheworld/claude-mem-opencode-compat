/**
 * OpenCode plugin event contract.
 *
 * WHY THIS FILE EXISTS (upstream issue #2854):
 * OpenCode's plugin loader walks EVERY export of a plugin module and requires
 * each one to be a function. It throws `TypeError("Plugin export is not a
 * function")` on the first export that is not. The two constants below are
 * runtime arrays, so exporting them from the plugin's own entrypoint made the
 * plugin fail to load entirely.
 *
 * Keeping them here means `index.ts` can import the derived TYPE (types are
 * erased at build time and never become a runtime export) while the arrays
 * themselves stay available to the contract test. Do not re-export these from
 * `index.ts` — that would reintroduce the loader crash.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are:
 *
 *   - `tool.execute.after`                  (input, output) — after every tool run
 *   - `chat.message`                        ({}, output)    — on each chat message
 *   - `event`                               ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`                     — when a session compacts
 *   - `experimental.chat.system.transform`  (input, output) — inject memory into the system prompt
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The only bus event types claude-mem reacts to are
 * `session.deleted` (forget the session mapping) and `session.idle` (best-effort
 * summarize). Session creation/observation capture is driven by the dedicated
 * `tool.execute.after` / `chat.message` hooks above, not by bus events — that is
 * the #2435 fix: the old code subscribed to non-existent bus types
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`)
 * and therefore captured nothing.
 *
 * REAL_OPENCODE_EVENT_TYPES is the allowlist of bus `event.type` values the
 * plugin is permitted to switch on. The contract test asserts the plugin only
 * references names in this list so a future typo fails CI.
 */
export const REAL_OPENCODE_EVENT_TYPES = [
  "session.idle",
  "session.deleted",
] as const;

export type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/** The hook keys this plugin returns. The contract test asserts these are the real OpenCode hook names. */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
] as const;
