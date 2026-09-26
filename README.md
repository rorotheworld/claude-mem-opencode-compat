# claude-mem-opencode-compat

A tracking fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) carrying
fixes to its **OpenCode** integration. Everything else is upstream — read the
[upstream README](https://github.com/thedotmack/claude-mem#readme) for what claude-mem is and
how to use it.

This fork exists to track a patch set against a moving upstream, not to compete with it.

## What differs from upstream

All remaining changes are in `src/integrations/opencode-plugin/` (+ one Chroma cleanup).

**1. The plugin could not load at all** — upstream
[#2854](https://github.com/thedotmack/claude-mem/issues/2854), open since 2026-06-09.
`index.ts` exported two runtime arrays alongside the plugin function. OpenCode's loader walks
every export and throws `Plugin export is not a function` on the first non-function it finds.
The contract constants moved to `contract.ts`; the entrypoint now imports only the derived
type, which TypeScript erases at build time, so it exports functions exclusively. A test fails
on any future non-function export.

**2. Every session recorded its prompt as `[media prompt]`.** `ensureSessionInitialized` posted
a hardcoded `prompt:""`, and the worker substitutes that sentinel for an empty value. The
damage was not the junk timeline rows — the sentinel became the `<user_request>` handed to the
extraction agent for every observation batch, so the extractor was never told what was asked.
`chat.message` already received the text and discarded it on a role check before init ran. It
now captures and forwards the prompt, filtering synthetic parts so an `@file` mention does not
turn a one-line prompt into kilobytes of tool scaffolding.

**3. OpenCode and Claude Code memories never shared a project bucket.** `ctx.project.name` is
optional in OpenCode's schema and unset in practice, so the `"opencode"` fallback fired every
time and filed all sessions under one global bucket regardless of directory. Now reuses
`getProjectContext`, the same helper the Claude Code path uses, which resolves the git repo
root.

A fourth fix — stamping sessions with `platformSource: opencode` so the worker did not
mislabel them as `claude` — graduated into upstream in commit `82a18e92` (issue #3678), and
this fork now uses upstream's central stamping. The fork also ports upstream's own OpenCode
fixes (`d1ae0cb2` input-args, `5babf0b1` persisted worker port) and keeps a small Chroma
prewarm hardening (`purgeStaleUvBuildTempDirs`) on top of upstream's #3540 work.

`experimental.chat.system.transform` pushes the project's memory timeline into OpenCode's
system prompt at session start, giving OpenCode the automatic context injection the Claude
Code path already gets.

## Layout

- `src/integrations/opencode-plugin/` — the source patch, the only hand-written difference
- `plugin/scripts/*.cjs`, `plugin/ui/viewer-bundle.js` — build output, regenerated rather than
  merged (see below)

## Staying current with upstream

`.github/workflows/sync-upstream.yml` runs daily. It replays the fork's source-patch commits
onto `upstream/main`, rebuilds the artifacts from scratch, and pushes the result to `main`.
That push is deliberate (a memory system that owns your data keeps working instances current
on the last reviewed shape, and generated-artifact commits are rebuilt rather than merged so
they never conflict) — only the source patch can conflict, and it touches one directory
upstream rarely edits.

If a sync fails (conflict, failing test, upstream API mismatch), the workflow files a tracking
issue and sends a Telegram alert; a failed sync leaves `main` untouched, so running instances
stay on the last good build.

## Licence

Upstream's licence applies. See [LICENSE](LICENSE).
