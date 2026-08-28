# Claude Code artifact workflow

Researched 2026-08-27 from Anthropic documentation and official source repositories.

## Short answer

The pasted page is the Claude Code artifact viewer, not the artifact source. Its outer document
contains Claude's header and an iframe whose content comes from a separate
`*.claudeusercontent.com` origin. The iframe is where the uploaded page runs. The HTML in the
prompt therefore does not tell us which component states or breakpoints the author included.

Claude Code now has a built-in `Artifact` publishing tool. It also applies a built-in design skill
when it creates an artifact. Anthropic's artifact docs describe that skill's behavior, but do not
name it or link to its instructions. The public
[`project-artifact` plugin](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/project-artifact/skills/project-artifact/SKILL.md)
is a separate, optional status-page workflow layered on top of the built-in tool. Anthropic also
publishes [`web-artifacts-builder`](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/SKILL.md)
and [`webapp-testing`](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md)
skills. Those pieces explain how Claude can compose a reusable frontend build, screenshot it, and
publish a polished comparison page. Artifact hosting itself does not discover component states or
take screenshots.

## What Claude Code actually provides

Anthropic defines a Claude Code artifact as one private, interactive page on `claude.ai`. Claude
writes an HTML or Markdown file, asks permission before its first upload, publishes it, and opens
the returned URL. Later publishes update the same URL. This is a Claude Code feature, not only the
older artifact panel in Claude web or desktop.
[`Share session output as artifacts`](https://code.claude.com/docs/en/artifacts)

There are three distinct layers:

1. The built-in `Artifact` tool uploads and versions an HTML or Markdown file. It is proprietary
   Claude Code functionality.
2. A built-in design skill influences palette, typography, and layout and checks the repository for
   an existing design system. Anthropic documents this behavior but does not publish the skill
   source.
3. Public skills and plugins add particular workflows. The official `project-artifact` skill, for
   example, renders a tabbed project status page and calls the built-in tool with `file_path`,
   `favicon`, `label`, and, for updates, the existing artifact `url`. It stores its working HTML and
   small config under `${CLAUDE_PLUGIN_DATA}` by default, outside the repository.
   [`Artifact design and constraints`](https://code.claude.com/docs/en/artifacts#improve-the-visual-design),
   [`project-artifact` implementation](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/project-artifact/skills/project-artifact/SKILL.md)

The Artifact tool requires a supported Claude plan, a Claude account login, Anthropic as the model
provider, and a supported interactive Claude Code or desktop surface. It is off by default in Agent
SDK, GitHub Action, and MCP-server contexts. The official `project-artifact` skill says it is not
available in non-interactive `claude -p` sessions. This matters for automation: Anthropic's own
publisher is not a general headless artifact API.
[`Artifact availability`](https://code.claude.com/docs/en/artifacts#availability)

## How the screenshots can be made

Claude Code has several browser paths. None is required by the Artifact tool.

### Claude in Chrome

Claude Code's Chrome integration drives a visible Chromium browser using the `claude-in-chrome`
MCP server. It can open a local app, click and type, read the console and network activity, take a
screenshot, save screenshots to disk, and record a GIF. It shares the user's browser login state,
so it is useful for exploratory checks and authenticated flows. Saved screenshots and GIFs can also
capture account details, which is an important publication warning.
[`Use Claude Code with Chrome`](https://code.claude.com/docs/en/chrome)

### Playwright code and Playwright MCP

Anthropic's public `webapp-testing` skill uses native Python Playwright scripts. Its workflow starts
the app, waits for `networkidle`, inspects the rendered page, then captures screenshots and performs
interactions. This is the most plausible source of a reusable, deterministic screenshot setup in a
repository.
[`webapp-testing` skill](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md)

Claude Code can also load Microsoft's Playwright MCP server globally, from a project `.mcp.json`,
or inline on a browser-testing agent. Anthropic's own subagent documentation includes an inline
`@playwright/mcp@latest` example whose instructions say to navigate, screenshot, and interact with
pages. The Playwright server supports fixed viewport sizes, isolated profiles, storage state, full
page screenshots, and an output directory.
[`Playwright subagent example`](https://code.claude.com/docs/en/sub-agents),
[`Playwright MCP`](https://github.com/microsoft/playwright-mcp)

Project-scoped MCP configuration lives in `.mcp.json` and can be committed for a team. Plugins can
ship their own MCP server plus skills and hooks. This is how a Claude plugin could install browser
tools and the artifact workflow together, although project-scoped servers still have explicit trust
and approval behavior.
[`MCP installation scopes`](https://code.claude.com/docs/en/mcp#mcp-installation-scopes),
[`Claude Code plugins`](https://code.claude.com/docs/en/plugins)

For a repeatable state-by-breakpoint gallery, ordinary Playwright code is the stronger foundation.
Chrome integration and MCP are good ways for an agent to inspect and debug. A checked-in test or
fixture records the routes, state setup, viewport list, waits, and selectors needed to reproduce the
same captures next week.

## Packaging, isolation, versions, and sharing

The documented Claude package is deliberately small:

- One `.html`, `.htm`, or `.md` file, with a rendered maximum of 16 MiB.
- One page and no backend. Relative multi-page routes do not work.
- A strict Content Security Policy blocks remote scripts, styles, images, `fetch`, XHR, and
  WebSockets. CSS and JavaScript are inlined, while images normally become data URIs. Google Fonts
  and connector calls are the documented exceptions.
- Claude wraps the uploaded file in an HTML shell. The viewer runs it from a sandboxed
  `*.claudeusercontent.com` origin.
- MCP calls made by a viewed artifact go through Claude's connector bridge. They use each viewer's
  own Claude account and declared connector allowlist. Local MCP servers from `.mcp.json` can help
  build the page but cannot be called by the published page.

[`Page constraints`](https://code.claude.com/docs/en/artifacts#page-constraints),
[`Artifact connector behavior`](https://code.claude.com/docs/en/artifacts#pull-live-data-with-mcp-connectors)

Each publish creates a version. A stable artifact URL can update in place, and the share control can
pin the version viewers see or follow later versions. A different session needs the URL or an
artifact attached through `/artifacts`; otherwise it creates a new artifact. The official
`project-artifact` plugin persists the URL locally so later sessions can pass it back to the tool.
New artifacts start private, and widening access is a separate action in the browser.
[`Update and share artifacts`](https://code.claude.com/docs/en/artifacts#update-an-artifact)

Anthropic stores organization artifact content on Anthropic-operated infrastructure. Organization
owners can configure private and shared retention periods. The Compliance API can list artifacts,
retrieve a specific version's content, and delete an artifact.
[`Artifact administration`](https://code.claude.com/docs/en/artifacts#manage-artifacts-for-your-organization)

## What is not public

The following details should stay labelled as inference:

- The pasted iframe URL contains a manifest identifier and version-looking tokens. Anthropic does
  not document that manifest format, its asset protocol, cache layout, or whether those tokens are
  durable identifiers.
- The artifact docs do not name the built-in design skill or link to its prompt and implementation.
  None of the official sources reviewed exposes that internal contract.
- Anthropic does not publish the Artifact tool's network protocol as a supported third-party API.
  The official plugin shows the model-facing inputs, but not the service contract behind them.
- Nothing in the public Artifact docs automatically enumerates component props, fixture states,
  routes, or responsive breakpoints. The before-and-after state matrix was authored by the agent or
  a project-specific test setup.
- The sandbox attributes visible in the supplied viewer HTML describe that response, not a promised
  long-term interface. The documented contract is the separate sandboxed origin and strict CSP.

## Implications for Soloe

Soloe should copy the separation of concerns, not the proprietary Claude endpoint.

### 1. Give every CLI agent a Soloe-owned publish operation

Expose both an MCP tool and a small CLI command with the same service underneath. A useful shape is:

```text
publish_artifact(
  cwd,
  bundle_path,
  expected_version_id?
) -> { artifact_id, version_id, view_url }
```

The bundle manifest contains its stable artifact key, title, entry point, and metadata. Soloe
resolves the Worktree and Project from `cwd`. The first call for a key mints a stable artifact ID;
later calls create immutable versions under it. `expected_version_id` gives Soloe a clean conflict
check when two agents publish concurrently. Publishing remains local and private. A Project setting
can opt into automatic publication after frontend work instead of prompting for every version.

### 2. Keep the global skill thin and the project setup durable

The Soloe installation can own the skill, templates, publisher connection, and generic screenshot
runner. The repository should own only facts needed to reproduce its UI states:

```text
.soloe/
  visual-review.yml       # routes, states, fixtures, breakpoints, masking rules
  visual-review/          # project-specific adapters only when existing tests are insufficient
  generated/              # ignored capture output, safe to delete and reproduce
```

When the repository already has Playwright, Storybook, component tests, or an E2E server command,
the skill should adapt those. If it lacks a test entry point, the skill can add a small fixture and
Playwright spec under the repository's existing test convention, then record the mapping in
`.soloe/visual-review.yml`. Generated HTML and screenshots do not need to be committed if Soloe
stores every published version, but the manifest and any fixture code should be commit-friendly so
another machine can reproduce them. The stable artifact identity belongs in Soloe's data store,
keyed by Project and manifest key. It should not be a mutable state file in the Worktree.

### 3. Make capture and publication separate commands

`soloe artifact capture` should start or reuse the app, render the declared state and breakpoint
matrix, mask secrets and unstable regions, save screenshots, and produce a self-contained review
page. `soloe artifact publish` should validate and upload that output. This split lets CI produce the
same review without a desktop UI and lets an agent inspect captures before any data leaves the
machine.

### 4. Treat an artifact version as an immutable bundle

Use a manifest plus content-addressed files rather than forcing everything into one giant HTML
string. A version can contain `index.html`, screenshot assets, the scenario manifest, and capture
metadata such as commit SHA, viewport, theme, and timestamp. Soloe can still offer a single-file
export for portability. Content hashes deduplicate unchanged screenshots between versions.

Render untrusted artifact code in an opaque iframe origin with a restrictive CSP and sandbox. Do
not give the iframe ambient access to Soloe's filesystem, Electron APIs, authentication tokens, or
local network. A dedicated content origin adds another layer when the bundle host grows beyond the
single-file implementation. Any live data bridge should use an explicit per-artifact allowlist and
viewer approval.

### 5. Put state navigation in the manifest

The host should understand optional `states`, `breakpoints`, `themes`, `beforeVersion`, and
`afterVersion` fields. Soloe can then provide consistent state and version controls outside the
uploaded page, while the page remains free to build a richer comparison. This avoids asking every
agent to reinvent the outer gallery UI and still allows one-off HTML artifacts with no visual-test
metadata.

The practical workflow is therefore: a global Soloe skill detects frontend work, reuses or creates
a project-local visual test setup, captures the requested states and breakpoints, builds a review
bundle, and calls Soloe's MCP or CLI publisher. Soloe stores the bundle and versions as Project data
and opens the artifact in its own full-screen pane.

## Mapping this design onto the current Soloe codebase

The existing agent bridge is already the right external seam. `SoloeMcpServer` exposes authenticated
tools, and `HookInstaller` installs that bridge for Claude Code and Codex. Add one deep operation to
that interface:

```text
publish_artifact({
  cwd,
  bundlePath,
  expectedVersionId?
}) -> {
  artifactId,
  versionId,
  viewUrl
}
```

The bundle manifest owns title, stable key, entry point, and optional visual-review metadata. The
caller supplies a Worktree path, not a Project ID. The Application Server resolves and authorizes
the Worktree, derives the Project, computes Git and Session provenance, validates that every bundle
file stays below the selected directory, and copies the bundle into its own data directory. This
matches Soloe's rule that filesystem operations use an explicit Worktree Scope rather than mutable
renderer context.

The new domain module should sit beside `NotesStore`, not inside the renderer or browser-session
store. A useful layout is:

```text
packages/domain/src/artifacts/ArtifactStore.ts
shared/types/artifacts.ts
<dataDirectory>/artifacts/<project-id>/index.json
<dataDirectory>/artifacts/<project-id>/versions/<artifact-id>/<version-id>/...
```

`SoloeDomain` should instantiate the store, expose bounded `artifacts` RPC methods, pass a narrow
publisher adapter to `SoloeMcpServer`, and publish `artifacts.change` after a successful version.
The current `BrowserSessionStore` is a good durability precedent, while `NotesStore` is the closer
Project-owned storage precedent. Artifact contents must never live in `RightRailStore` localStorage.

Add `artifacts` as the first `RailTabId` and render it through a lazy `RailArtifactsTab`. A publish
event should select the new version, open the Artifacts rail surface, and call the existing
`setFullscreenTab('artifacts')`. The current rail already supports this presentation behavior, so
the Artifact module does not need a second window or a special application layout.

For the first implementation, require one self-contained HTML entry file and store its metadata as
an immutable version. Render it in an iframe with only `allow-scripts`, no `allow-same-origin`, no
forms, popups, downloads, or top navigation. Apply a CSP that denies connections and remote assets.
This is enough for comparison controls, image zoom, and local filtering while preventing the report
from reading Soloe credentials, calling renderer functions, or reaching the local network. A later
bundle host can add content-addressed assets without changing the ArtifactStore interface.

### Install one workflow through provider adapters

Soloe should ship one `soloe-visual-review` skill as an application resource, then install a copy
for each enabled provider on that Device. Claude Code loads personal skills from
`~/.claude/skills/<name>/SKILL.md`; Codex loads personal skills from
`~/.agents/skills/<name>/SKILL.md`. Both products also recommend plugins when a skill and MCP server
need reusable distribution. Soloe already owns dynamic MCP URL and token installation, so direct
personal-skill installation is the smaller first implementation.
[`Claude Code skill locations`](https://code.claude.com/docs/en/slash-commands#where-skills-live),
[`Codex skill locations and distribution`](https://learn.chatgpt.com/docs/build-skills),
[`Codex MCP configuration`](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Do not grow `HookInstaller` into a second workflow system. Keep its existing hook and MCP behavior,
and add an `AgentWorkflowInstaller` with real Claude and Codex adapters. The Agent Integrations UI
can orchestrate both modules and report hook, MCP, and visual-review-skill status separately. Every
write should keep the current backup, atomic-write, ownership-marker, and per-Device behavior.

The skill must activate before frontend edits so it can capture a trustworthy baseline. Its normal
sequence is:

1. Read `.soloe/visual-review.yml` and discover existing Playwright, Storybook, component-test, or
   E2E commands.
2. Select scenarios affected by the requested files and capture the baseline before editing.
3. Make the frontend change and run the repository's ordinary verification.
4. Capture the same scenario matrix after editing with fixed viewports, locale, time, motion, and
   test data.
5. Build the report shown in the supplied screenshot: summary, design or vocabulary decisions,
   before-and-after matrix, changed files, checks, and unresolved visual concerns.
6. Call `publish_artifact`. A successful publish opens that immutable version in the Artifacts rail
   surface.

If the Project has no manifest, the skill should first reuse existing test routes and fixtures. It
should create project-specific adapter code only for states that cannot be reached through the
existing application. The generic capture runner and report template stay with Soloe rather than
being copied into every repository.
