// Rebrands the plugin marketplace manifest for this fork.
//
// Run after `bun run build`. It is idempotent and derives everything from
// upstream's own manifest, so a rebase onto new upstream never conflicts here -
// this file rewrites the output rather than patching it in git.
//
// Why it is needed: upstream's marketplace is named "thedotmack". Adding this
// fork to Claude Code under that same name would collide with an existing
// marketplace entry, and the installed plugin id (`claude-mem@thedotmack`)
// would be ambiguous. Renaming the marketplace makes the fork installable
// alongside upstream as `claude-mem@roro-opencode-compat`.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MARKETPLACE_NAME = "roro-opencode-compat";
const REPO = "rorotheworld/claude-mem-opencode-compat";

const targets = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

let changed = 0;

for (const path of targets) {
  if (!existsSync(path)) continue;

  const manifest = JSON.parse(readFileSync(path, "utf8"));

  manifest.name = MARKETPLACE_NAME;
  manifest.owner = { name: "roro" };
  manifest.metadata = {
    ...(manifest.metadata ?? {}),
    description:
      "Tracking fork of thedotmack/claude-mem with fixes to its OpenCode integration. " +
      `See https://github.com/${REPO}`,
  };

  // Leave plugin names and versions alone. The plugin stays `claude-mem`, so it
  // installs as claude-mem@roro-opencode-compat, and the version keeps tracking
  // upstream - which is what makes Claude Code notice an update when upstream
  // releases.
  for (const plugin of manifest.plugins ?? []) {
    plugin.description =
      (plugin.description ?? "") + " (OpenCode-compatible fork)";
  }

  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`rebranded ${path} -> ${MARKETPLACE_NAME}`);
  changed++;
}

if (changed === 0) {
  console.error("No marketplace manifest found; upstream layout may have changed.");
  process.exit(1);
}
