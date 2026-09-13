import { z } from "zod";
import { join } from "node:path";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { normalizePlatformSource } from "../../shared/platform-source.js";
import { getProjectContext } from "../../utils/project-name.js";

// Type-only import. TypeScript erases this at build time, so it never becomes a
// runtime export of this module. That matters: OpenCode's plugin loader rejects
// any module with a non-function export (#2854). See ./contract.ts for the full
// event contract and the hook list.
import type { RealOpenCodeEventType } from "./contract.js";

/**
 * IMPORTANT: every export of this file must be a function.
 *
 * OpenCode's plugin loader iterates the module's exports and throws
 * `TypeError("Plugin export is not a function")` on the first non-function it
 * finds. The event-contract arrays that used to live here are now in
 * ./contract.ts for exactly that reason — do not re-export them from this file.
 */

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  // d1ae0cb2: OpenCode may carry the tool's arguments here rather than in the
  // output payload.
  args?: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  // `synthetic` marks parts OpenCode injected itself rather than text the user
  // typed — e.g. the "Called the Read tool with the following input: ..." blocks
  // and whole file bodies added for an `@file` mention. They must be excluded
  // when reconstructing the user's actual prompt, or a one-line prompt turns
  // into a multi-kilobyte blob.
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

function resolveWorkerPort(): string {
  // Read the persisted settings file so the port honours what the worker actually
  // persisted, without importing worker-utils (#3365). Mirrors upstream.
  const settingsPath = join(
    SettingsDefaultsManager.get("CLAUDE_MEM_DATA_DIR"),
    "settings.json",
  );
  return SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_WORKER_PORT;
}

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// The worker defaults an absent platformSource to "claude", which silently
// mislabelled every OpenCode session. platformSource is stamped centrally in
// workerPostFireAndForget (upstream 82a18e92): normalizePlatformSource("opencode")
// is a recognised value in src/core/schemas/agent-event.ts.

// Upper bound on the prompt text we forward to the worker. The worker itself
// caps at 256 KB, but this string is re-embedded into the extraction agent's
// system prompt for every observation batch in the session, so a smaller cap
// keeps that cost sane for small local models.
const MAX_PROMPT_LENGTH = 8000;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...body,
      // Stamped on every session-write POST upstream (#3678). The spread order
      // means this wins over any accidental body.platformSource, so the worker
      // can never be told an OpenCode event came from "claude".
      platformSource: normalizePlatformSource("opencode"),
    }),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  });
}

async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, { headers: JSON_HEADERS });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const initializedSessionIds = new Set<string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        initializedSessionIds.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

/**
 * The worker has no "session.created" event in OpenCode, so we lazily initialize
 * the session the first time we see any activity for it (tool run or chat
 * message). This guarantees a session row exists before observations arrive.
 *
 * `prompt` carries the user's actual request when we have it. Sending an empty
 * string makes the worker substitute the literal sentinel "[media prompt]",
 * which then becomes the session's stored prompt AND the `<user_request>` the
 * extraction agent is given for every observation batch — i.e. the extractor is
 * told the user asked for nothing. Always pass the real text when available.
 *
 * When a prompt IS supplied we re-post init even for an already-initialized
 * session. That matches the Claude Code path, which posts one init per user
 * prompt so `<user_request>` tracks the current task rather than freezing on the
 * first one. The worker is built for this: `findRecentDuplicateUserPrompt`
 * dedupes identical text inside a 10-second window.
 */
function ensureSessionInitialized(
  openCodeSessionId: string,
  projectName: string,
  prompt = "",
): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  const isFirstInit = !initializedSessionIds.has(openCodeSessionId);

  // Post when the session is new, or whenever we have real prompt text to record.
  if (isFirstInit || prompt) {
    initializedSessionIds.add(openCodeSessionId);
    workerPostFireAndForget("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt,
    });
  }
  return contentSessionId;
}

/**
 * Rebuild the user's typed prompt from an OpenCode chat message.
 *
 * Only genuine text parts count: `synthetic` parts are scaffolding OpenCode
 * injects (tool-call descriptions, expanded `@file` contents) and would balloon
 * a short prompt into kilobytes of noise.
 *
 * Returns an empty string for a media-only turn, which is the one case where
 * the worker's "[media prompt]" sentinel is genuinely correct.
 */
function extractUserPromptText(parts: ChatMessageOutput["parts"]): string {
  const text = (parts || [])
    .filter(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true,
    )
    .map((part) => part.text as string)
    .join("\n")
    .trim();

  return text.length > MAX_PROMPT_LENGTH ? text.slice(0, MAX_PROMPT_LENGTH) : text;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

// ---------------------------------------------------------------------------
// Session-start memory injection
//
// Claude Code gets its memory timeline pushed into the model's context
// automatically at session start. OpenCode had no equivalent, so past work was
// only reachable if the model happened to call the search tool. The
// `experimental.chat.system.transform` hook below closes that gap.
// ---------------------------------------------------------------------------

const INJECT_TIMEOUT_MS = 5000;
const INJECT_BACKOFF_BASE_MS = 15_000;
const INJECT_BACKOFF_MAX_MS = 300_000;

// Cached per session. The transform hook runs on EVERY model request, not once
// per session, so without this we would re-fetch the whole timeline constantly.
const contextBySessionId = new Map<string, string | Promise<string | null>>();

// Shared failure state. Deliberately module-scoped rather than per-session: if
// the worker is down, new sessions should not each pay the timeout to rediscover
// that.
let injectFailureCount = 0;
let injectBlockedUntilMs = 0;

function noteInjectFailure(): void {
  injectFailureCount += 1;
  const backoff = Math.min(
    INJECT_BACKOFF_BASE_MS * 2 ** (injectFailureCount - 1),
    INJECT_BACKOFF_MAX_MS,
  );
  injectBlockedUntilMs = Date.now() + backoff;
}

function noteInjectSuccess(): void {
  injectFailureCount = 0;
  injectBlockedUntilMs = 0;
}

/**
 * Fetch the memory timeline for a project.
 *
 * Returns null on any failure, and records a bounded exponential backoff so a
 * dead worker does not add a 5-second stall to every single turn.
 */
async function fetchInjectContext(projectsParam: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INJECT_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${WORKER_BASE_URL}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`,
      { signal: controller.signal },
    );

    if (!response.ok) {
      console.warn(`[claude-mem] Context inject returned ${response.status}`);
      noteInjectFailure();
      return null;
    }

    // The worker answers 200 with a JSON body when it is still starting up:
    // {"content":[{"type":"text","text":""}]}. A successful response is always
    // text/plain, so content-type is an exact, cheap way to tell them apart.
    // Without this check that raw JSON gets injected into the system prompt and
    // cached for the rest of the session.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/plain")) {
      console.warn(
        `[claude-mem] Context inject not ready (content-type: ${contentType || "none"})`,
      );
      noteInjectFailure();
      return null;
    }

    const text = (await response.text()).trim();
    if (!text) {
      noteInjectFailure();
      return null;
    }

    noteInjectSuccess();
    return text;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Context inject failed: ${message}`);
    }
    noteInjectFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Work out which memory "project" bucket this session belongs to.
 *
 * OpenCode leaves `ctx.project.name` unset (it is optional in OpenCode's own
 * schema), so the old `ctx.project?.name || "opencode"` fallback fired every
 * time and filed EVERY OpenCode session under the literal bucket "opencode",
 * regardless of directory. Claude Code meanwhile derives the name from the
 * working directory, so the two harnesses never shared memory even when
 * launched from the same folder.
 *
 * `getProjectContext` is the exact helper the Claude Code path uses
 * (src/cli/handlers/session-init.ts). It resolves the git repo root, so the
 * name stays stable across subdirectories and worktrees.
 */
function resolveProjectName(ctx: OpenCodePluginContext): string {
  // An explicit name from OpenCode wins if it is ever actually provided.
  if (ctx.project?.name) return ctx.project.name;

  try {
    const derived = getProjectContext(ctx.directory).primary;
    if (derived) return derived;
  } catch (error: unknown) {
    console.warn(
      `[claude-mem] Could not derive project name from ${ctx.directory}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  return "opencode";
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = resolveProjectName(ctx);

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        // d1ae0cb2: OpenCode may deliver the arguments in the input payload
        // instead of the output. Prefer input args, keep output as fallback.
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // Capture user prompts (to record what was actually asked) and assistant
    // chat messages (as observations).
    "chat.message": async (
      _input: Record<string, unknown>,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID;
      if (!sessionID) return;

      // User turn: this is the ONLY place the plugin ever sees what the user
      // actually typed. It fires during prompt assembly, before the model runs
      // and therefore before any tool call, so the prompt reaches the worker on
      // the session's very first init rather than arriving too late.
      if (output.message?.role === "user") {
        const promptText = extractUserPromptText(output.parts);
        // An empty result means a media-only turn; init with no prompt and let
        // the worker apply its "[media prompt]" sentinel, which is correct there.
        ensureSessionInitialized(sessionID, projectName, promptText);
        return;
      }

      if (output.message?.role !== "assistant") return;

      const contentSessionId = ensureSessionInitialized(sessionID, projectName);
      const messageText = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (!messageText) return;

      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
      });
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          // Best-effort summarize once a session goes idle.
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
          contextBySessionId.delete(sessionID);
          break;
        }
        default:
          // Ignore all other bus events.
          break;
      }
    },

    // Push the project's memory timeline into the system prompt, giving OpenCode
    // the same automatic session-start context Claude Code already gets.
    //
    // This hook fires on every model request, so the result is cached per
    // session and a failed fetch backs off rather than retrying each turn.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ): Promise<void> => {
      // OpenCode invokes hooks with Effect.promise and does not catch
      // rejections — an uncaught throw here is a defect that kills the user's
      // chat turn. Everything below stays inside this try/catch.
      try {
        if (!Array.isArray(output?.system)) return;

        const sessionId = input?.sessionID || `project:${projectName}`;
        let entry = contextBySessionId.get(sessionId);

        if (entry === undefined) {
          // Still inside the backoff window: return immediately without
          // awaiting, so a dead worker costs nothing per turn.
          if (Date.now() < injectBlockedUntilMs) return;

          const pending = fetchInjectContext(projectName);
          contextBySessionId.set(sessionId, pending);

          // Replace the promise with the resolved text, or drop the entry so a
          // later turn can retry. Leaving a resolved-null promise cached would
          // disable injection for the whole session with no recovery.
          void pending.then(
            (value) => {
              if (value) contextBySessionId.set(sessionId, value);
              else contextBySessionId.delete(sessionId);
            },
            () => contextBySessionId.delete(sessionId),
          );

          entry = pending;
        }

        const context = typeof entry === "string" ? entry : await entry;
        if (context) output.system.push(context);
      } catch (error: unknown) {
        console.warn(
          "[claude-mem] System prompt transform failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: z.string().describe("Search query for memory observations"),
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const query = String(args.query || "");
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          return parseSearchResponse(text, query);
        },
      },
    },
  };
};

/**
 * The worker returns Claude-style `{ content: [{ type: 'text', text: '...' }] }`
 * blocks, NOT `{ items: [...] }` (#2406). Concatenate the text blocks and return
 * them verbatim; an empty block list or a "No observations found" body becomes a
 * clear no-results message.
 */
export function parseSearchResponse(text: string, query: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    console.warn(
      "[claude-mem] Failed to parse search results:",
      error instanceof Error ? error.message : String(error),
    );
    return "Failed to parse search results.";
  }

  const content = (data as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return `No results found for "${query}".`;
  }

  const rendered = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  if (!rendered) {
    return `No results found for "${query}".`;
  }

  return rendered;
}

export default ClaudeMemPlugin;
