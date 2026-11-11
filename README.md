# squarespace-mcp

An MCP server that lets Claude build and edit **Squarespace 7.1** sites: site colors, fonts and buttons, pages and Fluid Engine sections, images, blog posts and summary-card grids. It's designed for turning Claude Design exports into native Squarespace sections that the site owner can keep editing in the normal Squarespace editor.

Squarespace has no public API for building pages, so this uses the **editor's own internal API**, reverse-engineered from the requests the editor makes. It's unofficial and unsupported: Squarespace can change it at any time, and using it may conflict with Squarespace's terms. Use it on sites you own or are allowed to edit, and test on a trial site first.

## How it works

```
Claude Desktop ──stdio──▶ MCP server (Node) ──WebSocket, 127.0.0.1:47321──▶ Chrome extension ──fetch──▶ *.squarespace.com
```

- The **Chrome extension** sends requests to Squarespace using the browser's existing login. Passwords and cookies never leave Chrome. It only contacts `*.squarespace.com`, and the server only accepts connections from this extension's fixed ID.
- The **MCP server** turns compact specs (theme, height, blocks at grid positions) into Squarespace's page JSON, and fills in each block's defaults from Squarespace's own component definitions.
- **Every write is snapshotted first** to `~/.squarespace-mcp/snapshots`, and `restore_snapshot` undoes it.

## Install

Download both files from the [latest release](../../releases/latest).

1. **Chrome extension:** unzip `squarespace-mcp-bridge-extension.zip` somewhere permanent. In `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `extension` folder.
2. **Claude Desktop:** double-click `squarespace-builder.mcpb` and click **Install**. Optionally set your default site, e.g. `my-site`.
3. Log in to Squarespace in Chrome, then ask Claude: *"Check the Squarespace connection."*

## Tools

| Area | Tools |
|---|---|
| Setup | `status`, `read_design` (unpacks a Claude Design export into an outline plus image files) |
| Pages | `list_pages`, `get_page`, `create_page`, `set_navigation_order` |
| Sections and blocks | `build_sections`, `update_section`, `update_block`, `delete_sections`, `describe_block` |
| Images | `upload_image`, `set_post_image` |
| Site styles | `get_site_styles`, `set_palette`, `set_theme_colors`, `set_fonts`, `set_button_style`, `get_custom_css`, `set_custom_css` |
| Header and footer | `get_header_footer`, `update_header`, `build_footer` |
| Blog | `list_posts`, `create_blog_post`, `update_blog_post` |
| Safety | `list_snapshots`, `restore_snapshot`, `api_request` (escape hatch, `/api/` paths only) |

Layout uses Squarespace's Fluid Engine grid: 24 columns on desktop and 8 on mobile, with 1-based positions given as `{x, y, w, h}`. If you leave out the mobile positions, blocks stack full-width in reading order.

## Verified vs. untested

Tested end to end on a trial site: site palette, color themes, fonts and type sizes, button styles, custom CSS, building and editing sections (text, button, image, line, summary), image upload, blog posts with body images and featured images, summary-card grids, and snapshot restore.

Not yet exercised through the MCP: `create_page`, `set_navigation_order`, `update_header`, `build_footer`, and section background images.

## Development

```bash
cd server && npm ci
```

```bash
node server/test/run.mjs server/test/example.json
```

The test harness starts the server, waits for the Chrome extension to connect, and runs the tool calls listed in a JSON file.

```bash
cd server && npx @anthropic-ai/mcpb pack . ../dist/squarespace-builder.mcpb
```

That builds the Claude Desktop bundle.

## License

MIT. See [LICENSE](LICENSE).
