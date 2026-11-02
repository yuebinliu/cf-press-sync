=== CF Press Sync ===
Contributors: yuebinliu
Tags: cms, headless, cloudflare, d1, r2, worker, static site
Requires at least: 5.5
Tested up to: 6.8
Requires PHP: 7.0
Stable tag: 2.2.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Use WordPress as the editing backend for a self-hosted CMS on Cloudflare. Posts sync to D1, pages are rendered by the Worker.

== Description ==

CF Press Sync turns WordPress into the **content backend** of a self-hosted CMS that runs on Cloudflare Workers.

You keep writing in WordPress. Every save pushes the post into D1. When a reader visits the site, the Worker pulls the row from D1, renders it with your theme, writes the HTML back to R2 and serves it. WordPress never has to be online for the site to work.

**What this plugin does**

* Syncs posts, categories, tags, excerpts, featured images, markdown flags and comment settings into Cloudflare D1
* Uploads images referenced in post content to R2, so the static site does not hotlink back to WordPress
* Deletes the stale R2 copy of a post when its data changes, so the Worker re-renders it on next visit
* One-way comment sync (WordPress → D1) and pull-back (D1 → WordPress) so readers' comments land in the WordPress admin for moderation
* Pulls posts that were created in the CMS backend into WordPress
* Manages the Worker: creates the admin account, regenerates `routes.js` from your permalink settings, deploys the Worker with `wrangler`
* Works with multiple sites: each post can be assigned to one or more hosting targets

**What this plugin does not do**

It does not generate static files. There is no local export directory, no HTML rendering on the WordPress side, no "upload to R2" step for pages. All of that belongs to the Worker, which renders on demand — so changing a theme in the CMS backend takes effect immediately for every page, without rebuilding anything.

Third-party static hosting (Cloudflare Pages, GitHub Pages, Netlify, Vercel, FTP, WebDAV, S3) is handled by a separate plugin, **WP Static Deploy**. Do not enable both on the same site: they both hook `save_post`.

== Requirements ==

* PHP 7.0+ with the cURL extension
* A Cloudflare account (Worker, D1, R2, KV) — or let the plugin deploy the CMS release for you
* Node.js 18+ and `wrangler`, only if you want to deploy the Worker from the admin page

The plugin does not bundle the Worker. It downloads the CMS release from its own releases page, so the version you deploy always matches the published one.

== Installation ==

1. Upload the `cf-press-sync` folder to `/wp-content/plugins/`, or upload the zip under **Plugins → Add New → Upload Plugin**.
2. Activate **CF Press Sync**.
3. Go to **Settings → CF Press 同步**.
4. Enter **站点地址（Worker 域名）** and the **Auth Key** (the value you stored as `AUTH_KEY_SECRET` on the Worker), then press **Test connection**.
5. In **🎯 托管目标 → ⚙️ 配置**, fill in the Cloudflare account ID, API token, R2 bucket and D1 database ID.
6. If the CMS is not deployed yet: **下载发行包**, then **部署到 Cloudflare**. Both buttons need `wrangler` installed and logged in on the machine that runs WordPress.
7. Under **用户**, press **写入 / 重置密码** to create the CMS admin account.
8. Press **同步文章到 CMS** for the first full export.

== Frequently Asked Questions ==

= Where do the pages come from if nothing is generated? =

From the Worker. When a request misses R2, `routes.js` calls `renderSinglePageOnDemand()`, which reads the row from D1, renders it with the active theme and writes the result back to R2. The plugin's only job is to keep D1 current and to delete the stale R2 copy so the Worker knows to re-render.

= Why is the old page deleted instead of overwritten? =

Because the WordPress side does not render HTML. Deleting is cheap (one API call), and the Worker regenerates the page on the next visit with whatever theme is active at that moment.

= Do I need to keep WordPress online? =

Only while editing. The published site is served entirely from the Worker, R2 and the edge cache.

= Can I use it together with WP Static Deploy? =

Not on the same site. Both hook `save_post` and would fight over the same content. Use one or the other.

== Changelog ==

= 1.0.0 =
* Split out of CF Static Export Pro 2.5.0 as the CMS-sync half.
* Removed the rendering pipeline (`generate_post_html` / `render_with_template` / `fetch_from_frontend` / `post_process_html`), the local artifact writer and the R2 page uploader.
* `export_post()` now only writes D1, syncs media and invalidates the stale R2 page.
* Removed the template editor and theme-asset staging (themes are managed in the Worker admin, stored at `wp-content/themes/<id>/tpl.json` in R2).
* Removed third-party hosting transports (GitHub / GitLab / Netlify / Vercel / FTP / WebDAV / local directory) — those live in WP Static Deploy.
* Serial bulk sync replaces the `exec`-based concurrent exporter.
* `worker/wrangler.toml` is generated from `.example` on first deploy, with D1 / R2 pre-filled from the plugin settings.
* Bundled Worker runtime trimmed to a single built-in theme (`cfse-demo`).
