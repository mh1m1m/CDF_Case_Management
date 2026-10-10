# Google Stitch skills

Vendored from [google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills)
at commit `0337446dadde6f8c94210444e2aa9d546126480f` (Apache-2.0, see `STITCH_SKILLS_LICENSE`).

Only change from upstream: the frontmatter `name: stitch::<skill>` became `name: <skill>`,
because Claude Code skill names must be lowercase kebab-case. Directory names are unchanged,
so the skills' relative cross-references still resolve.

Not vendored (not relevant to this Next.js web app): `react-native`, `remotion`, `react-vite-dashboard`.

## What needs the Stitch MCP server

The Stitch MCP server is declared in the repo's `.mcp.json` and reads the key from the
`STITCH_API_KEY` environment variable. Never commit the key itself.

| Works without Stitch MCP or a key | Needs Stitch MCP (and so `STITCH_API_KEY`) |
|---|---|
| `extract-design-md` (stops before the upload hand-off) | `generate-design` |
| `extract-static-html` | `manage-design-system` |
| `enhance-prompt` | `upload-to-stitch` (also calls the Stitch REST API with the key) |
| `site-md` | `code-to-design` (chains extract, then upload) |
| `taste-design` | `design-md` (reads an existing Stitch project) |
| `shadcn-ui` (uses the shadcn MCP if present, else the CLI) | `react-components` (fetches Stitch screens) |
| | `stitch-loop` |

Synthetic data only: never upload real CDF data or screenshots to Stitch.

## Updating

Re-copy the folders from a newer upstream commit, re-apply the `name:` rewrite, and bump the
commit hash above.
