import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pluginModule from "../../src/integrations/opencode-plugin/index";
import {
  ClaudeMemPlugin,
  parseSearchResponse,
} from "../../src/integrations/opencode-plugin/index";
import { normalizePlatformSource } from "../../src/shared/platform-source";
// The event-contract constants live in contract.ts, NOT index.ts. OpenCode's
// plugin loader rejects any module with a non-function export (#2854), so the
// plugin entrypoint must export functions only. See the guard test below.
import {
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/contract";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness).
 *
 * The old plugin subscribed to bus event names that do not exist in OpenCode
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`,
 * `session.deleted` on a `(name, payload)` switch) and parsed `data.items`
 * instead of the worker's real `data.content` blocks — so it captured nothing
 * and search always returned "No results". These tests fail CI if either
 * contract regresses.
 */

// The real OpenCode plugin hook names. Anything the plugin returns as a hook
// key must be in this allowlist; a future typo (e.g. "session.created") fails.
const REAL_OPENCODE_HOOK_NAMES = new Set<string>([
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
  "tool.execute.before",
  "permission.ask",
  "auth",
  "config",
  // `tool` is the custom-tool registration map, part of the plugin return shape.
  "tool",
]);

// Bus event names the old code used that DO NOT exist in OpenCode's contract.
const PHANTOM_BUS_EVENT_NAMES = [
  "session.created",
  "message.updated",
  "session.compacted",
  "file.edited",
];

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

describe("OpenCode plugin event contract", () => {
  it("reads the worker port from persisted settings without importing worker-utils", () => {
    // 5babf0b1: the port must come from the persisted settings file, not from
    // worker-utils, so the plugin and the running worker cannot disagree.
    const source = readFileSync("src/integrations/opencode-plugin/index.ts", "utf8");

    expect(source).not.toContain('from "../../shared/worker-utils.js"');
    expect(source).toContain(
      "SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_WORKER_PORT",
    );
  });

  it("uses the persisted worker port in OpenCode worker requests", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "claude-mem-opencode-settings-"));
    const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const originalPort = process.env.CLAUDE_MEM_WORKER_PORT;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "45678" }),
    );

    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const { ClaudeMemPlugin: ReloadedPlugin } = await import(
        `../../src/integrations/opencode-plugin/index.ts?opencode-settings-${Date.now()}`
      );
      const plugin = await ReloadedPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_45678", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      expect(seenUrls.some((url) => url.startsWith("http://127.0.0.1:45678/"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
      if (originalPort === undefined) delete process.env.CLAUDE_MEM_WORKER_PORT;
      else process.env.CLAUDE_MEM_WORKER_PORT = originalPort;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts observations to the worker via tool.execute.after", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const toolAfter = plugin["tool.execute.after"];
      await toolAfter(
        { tool: "read", sessionID: "ses_1", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: { path: "/a" } },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_input).toEqual({ path: "/a" });
      expect(obsBody.tool_response).toBe("file contents");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers input args when both hook payloads contain arguments", async () => {
    // Same shape as the original issue capture: args can arrive on either
    // payload; input wins, output stays the fallback.
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "write", sessionID: "ses_precedence", callID: "c2", args: { path: "/input" } },
        { title: "Write", output: "ok", metadata: {}, args: { path: "/output" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({ path: "/input" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains output args as the fallback when input args are absent", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await plugin["tool.execute.after"](
        { tool: "write", sessionID: "ses_output_fallback", callID: "c3" },
        { title: "Write", output: "ok", metadata: {}, args: { path: "/output-only" } },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect((obsPost!.body as Record<string, unknown>).tool_input).toEqual({
        path: "/output-only",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stamps every session-write POST with the opencode platform source and leaves GET and deletion unchanged", async () => {
    // Walks every registered hook and asserts each POST carries the platform
    // tag, while search (GET) and session.deleted never POST. Mirrors upstream's
    // 82a18e92 coverage, extended for the fork's system.transform hook.
    const requests: Array<{
      method: string;
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method || "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "No observations found" }] }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      const expectedPlatformSource = normalizePlatformSource("opencode");

      const postHookInvocations: Record<string, () => Promise<void>> = {
        "tool.execute.after": () =>
          plugin["tool.execute.after"](
            { tool: "read", sessionID: "ses_contract_tool", callID: "c1" },
            { title: "Read", output: "tool output", metadata: {}, args: {} },
          ),
        "chat.message": () =>
          plugin["chat.message"](
            {},
            {
              message: { role: "assistant", sessionID: "ses_contract_chat" },
              parts: [{ type: "text", text: "assistant output" }],
            },
          ),
        "experimental.session.compacting": () =>
          plugin["experimental.session.compacting"]({ sessionID: "ses_contract_compact" }),
        event: () =>
          plugin.event({
            event: { type: "session.idle", properties: { sessionID: "ses_contract_idle" } },
          }),
        "experimental.chat.system.transform": async () => {
          // This hook GETs the context (never POSTs); exercise it so the
          // GET-alternative path is covered to. Pushes into output.system.
          const output = { system: ["baseline"] };
          await plugin["experimental.chat.system.transform"](
            { sessionID: "ses_contract_inject" },
            output,
          );
        },
      };
      for (const hook of REGISTERED_OPENCODE_HOOKS) {
        const invoke = postHookInvocations[hook];
        expect(invoke, `registered hook "${hook}" must have an invocation case`).toBeDefined();
        await invoke!();
      }

      const posts = requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(8);
      for (const post of posts) {
        expect(post.body?.platformSource).toBe(expectedPlatformSource);
      }

      // The search tool is a GET, and session.deleted deletes nothing remotely;
      // neither may produce a POST.
      await plugin.tool.claude_mem_search.execute({ query: "auth" });
      await plugin.event({
        event: { type: "session.deleted", properties: { sessionID: "ses_contract_idle" } },
      });
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(8);
      expect(requests.at(-1)?.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenCode plugin module export contract (#2854)", () => {
  it("exports ONLY functions from the plugin entrypoint", () => {
    // OpenCode's loader iterates every export of the module and throws
    // TypeError("Plugin export is not a function") on the first non-function.
    // Exporting the contract arrays from index.ts made the plugin fail to load
    // outright. Any new non-function export here breaks OpenCode again.
    const offenders = Object.entries(pluginModule)
      .filter(([, value]) => typeof value !== "function")
      .map(([name, value]) => `${name} (${typeof value})`);

    expect(
      offenders,
      `non-function exports break OpenCode's plugin loader: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("does not re-export the contract constants from the entrypoint", () => {
    expect(pluginModule).not.toHaveProperty("REAL_OPENCODE_EVENT_TYPES");
    expect(pluginModule).not.toHaveProperty("REGISTERED_OPENCODE_HOOKS");
  });
});

describe("OpenCode session-init prompt capture", () => {
  /** Run `fn` with fetch stubbed, returning every POST it made. */
  async function withCapturedPosts(
    fn: (plugin: Record<string, any>) => Promise<void>,
  ): Promise<Array<{ url: string; body: any }>> {
    const posts: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
    }) as typeof fetch;

    try {
      const plugin = await ClaudeMemPlugin(pluginCtx);
      await fn(plugin as unknown as Record<string, any>);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return posts;
  }

  it("sends the user's real prompt on session init, not an empty string", async () => {
    // An empty prompt makes the worker substitute the literal "[media prompt]",
    // which then becomes the <user_request> given to the extraction agent for
    // every observation batch in the session.
    const posts = await withCapturedPosts(async (plugin) => {
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_prompt_1" },
          parts: [{ type: "text", text: "add a retry to the upload path" }],
        },
      );
    });

    const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
    expect(initPost, "a user message should initialize the session").toBeTruthy();
    expect(initPost!.body.prompt).toBe("add a retry to the upload path");
    expect(initPost!.body.prompt).not.toBe("");
  });

  it("excludes synthetic parts from the captured prompt", async () => {
    // OpenCode injects synthetic parts for @file mentions and tool scaffolding.
    // Including them turns a one-line prompt into kilobytes of noise.
    const posts = await withCapturedPosts(async (plugin) => {
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_prompt_2" },
          parts: [
            { type: "text", text: "summarize @README.md" },
            {
              type: "text",
              text: "Called the Read tool with the following input: {...}",
              synthetic: true,
            },
            { type: "text", text: "<entire file body>", synthetic: true },
          ],
        },
      );
    });

    const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
    expect(initPost!.body.prompt).toBe("summarize @README.md");
  });

  it("tags posts with the opencode platform source", async () => {
    // Without this the worker defaults to "claude" and every OpenCode session is
    // mislabelled.
    const posts = await withCapturedPosts(async (plugin) => {
      await plugin["tool.execute.after"](
        { tool: "read", sessionID: "ses_platform", callID: "c1" },
        { title: "Read", output: "x", metadata: {}, args: {} },
      );
    });

    for (const post of posts) {
      expect(post.body.platformSource).toBe("opencode");
    }
  });

  it("leaves the prompt empty for a media-only turn", async () => {
    // This is the one case where the worker's "[media prompt]" sentinel is right.
    const posts = await withCapturedPosts(async (plugin) => {
      await plugin["chat.message"](
        {},
        {
          message: { role: "user", sessionID: "ses_media" },
          parts: [{ type: "image" } as { type: string }],
        },
      );
    });

    const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
    expect(initPost!.body.prompt).toBe("");
  });
});

describe("OpenCode search client response-shape contract", () => {
  it("parses the worker's real data.content blocks and returns the rows", () => {
    // This is exactly what SearchManager.searchObservations returns on a hit.
    const workerResponse = JSON.stringify({
      content: [
        {
          type: "text",
          text:
            'Found 2 observation(s) matching "auth"\n\n| # | Title |\n|---|---|\n1. Added login flow\n2. Fixed token refresh',
        },
      ],
    });

    const rendered = parseSearchResponse(workerResponse, "auth");
    expect(rendered).toContain("Found 2 observation(s)");
    expect(rendered).toContain("Added login flow");
    expect(rendered).toContain("Fixed token refresh");
    expect(rendered).not.toContain("No results");
  });

  it("does NOT parse the old data.items shape (regression guard)", () => {
    // The pre-fix worker contract was wrongly assumed to be { items: [...] }.
    // A client that still reads data.items would render rows here; the real
    // client reads data.content, so this is correctly reported as no results.
    const oldShape = JSON.stringify({
      items: [{ title: "should-not-render" }, { title: "also-not" }],
    });
    const rendered = parseSearchResponse(oldShape, "auth");
    expect(rendered).toContain("No results");
    expect(rendered).not.toContain("should-not-render");
  });

  it("returns a clear no-results message for the worker's empty-content shape", () => {
    const emptyResponse = JSON.stringify({
      content: [{ type: "text", text: 'No observations found matching "zzz"' }],
    });
    const rendered = parseSearchResponse(emptyResponse, "zzz");
    expect(rendered).toContain("No observations found");
  });
});
