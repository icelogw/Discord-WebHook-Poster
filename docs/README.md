<div align="center">

# Discord Webhook Poster

**Everything a Discord webhook can send, composed in your browser - with a local proxy that keeps
the webhook URL out of it.**

![no login](https://img.shields.io/badge/Discord%20login-not%20needed-57F287?style=flat-square)
![node](https://img.shields.io/badge/node-%E2%89%A518%20for%20source-5865F2?style=flat-square)
![dependencies](https://img.shields.io/badge/dependencies-0-57F287?style=flat-square)
![no build](https://img.shields.io/badge/build%20step-none-FEE75C?style=flat-square)
![licence](https://img.shields.io/badge/licence-personal%20use%20only-ED4245?style=flat-square)

<img src="https://github.com/icelogw/Discord-WebHook-Poster/raw/main/docs/screenshot.png" alt="The composer, with a message and embed on the left and a live Discord-style preview on the right" width="900">

</div>

---

Rich embeds, polls, Components V2, image upload, scheduling, and edit-after-send - with a live
preview that renders markdown, timestamps and embeds the way Discord will.

**No Discord login, no bot, no OAuth.** A webhook URL is the only thing it needs - you never sign
in to anything, and the app has no account of its own either.

## Download

**[Download the latest release](https://github.com/icelogw/Discord-WebHook-Poster/releases/latest)**
and take `DiscordWebhookPoster.exe` from it - one file, ~67 MB, **no Node required**. Put it in a
folder you can write to and double-click. It starts the proxy server, opens your browser, and
creates its own `.env` beside itself on first run.

Most of that size is the Node runtime; the app itself is under 200 KB.

> Windows SmartScreen will warn the first time - the exe is unsigned. *More info* → *Run anyway*.

---

Or run it from source:

| | **Exe** | **Proxy** |
|---|---|---|
| How | double-click it | `npm start` |
| Needs Node | no | Node 18+ |
| Where the webhook URL lives | `.env`, beside the exe | `.env`, server-side only |
| Who can post | anyone with the access token | anyone with the access token |
| Sends leave from | the bundled server | the server |

The two are the same thing - the exe is just proxy mode packaged with Node inside, so the webhook
URL never reaches the browser either way. Pick the exe if you don't want Node installed,
`npm start` if you're working on the source.

---

## Proxy mode

```bash
npm start
```

No install step - there are no dependencies. On first run it generates an access token and writes
`.env` itself.

The server prints a URL containing an access token and opens it:

```
  ╭────────────────────────────────────────────────────────────────╮
  │ Discord Webhook Poster                                  v1.0.0 │
  ├────────────────────────────────────────────────────────────────┤
  │ ready      http://localhost:3000/#token=Xf3k…                  │
  │ token      Xf3k…                                               │
  ├────────────────────────────────────────────────────────────────┤
  │ hooks      announcements, deploy-log                           │
  │ limit      20 sends/min per client                             │
  │ queue      on - sends without a browser                        │
  ├────────────────────────────────────────────────────────────────┤
  │ folder     C:\Users\you\Discord Webhook Poster                 │
  │ config     .env                                                │
  │ templates  templates.json                                      │
  │ log        DWP.log                                             │
  │ schedule   .schedule\                                          │
  ╰────────────────────────────────────────────────────────────────╯

  The link and the token are the keys to your channel - keep them private.
```

Three blocks: how to get in, what it is set up to do, and where it keeps its files. The token is
printed on its own line as well as inside the link, since the unlock prompt asks for it by itself -
handy if you reach the page from a bookmark. Every file lives in the one folder, so it is named
once and the rest are relative to it; each is listed whether or not it exists yet, because knowing
where it *will* be written is the point.

The page picks the token out of the URL fragment, stores it, and scrubs the address bar. From then
on the browser only ever names a webhook (`"announcements"`) - **it never receives a URL**. The
server holds the real URLs and posts to Discord itself.

### Adding webhooks

Use **+ Add** next to the dropdown. Give it a name, paste the webhook URL, save. The server writes
it to `.env` and returns only the updated list of names - the URL travels one way, into the server,
and is never sent back to the browser or stored there. **Remove** deletes it from `.env` again.

Before saving, the server asks Discord whether the webhook is real. A URL can be the right shape and
still be dead - a mistyped token, or a webhook deleted since it was copied - and finding that out on
your first send is too late. If Discord doesn't recognise it, nothing is written and you're told why;
if it does, you're told what it posts as and which channel it belongs to, so a webhook saved under
the wrong name is obvious immediately. If Discord can't be reached at all, it's saved anyway and
flagged as unchecked, since refusing over a network blip would be worse.

Or edit `.env` directly if you prefer; each `WEBHOOK_<name>` line's suffix becomes the dropdown name:

```ini
WEBHOOK_ANNOUNCEMENTS=https://discord.com/api/webhooks/…   # → "announcements"
WEBHOOK_DEPLOY_LOG=https://discord.com/api/webhooks/…      # → "deploy-log"
```

Editing the file by hand needs a restart; adding from the page takes effect immediately. Webhooks
supplied as real environment variables rather than `.env` show as *(from environment)* and can't be
changed from the page - the server can't persist a change it doesn't own.

### Configuration

All optional except the webhooks themselves. See
[.env.example](https://github.com/icelogw/Discord-WebHook-Poster/blob/main/docs/.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_TOKEN` | generated | Access token. Written to `.env` on first run. Rotate by deleting the line. |
| `PORT` | `3000` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. Anything else also requires `ALLOW_INSECURE=1`. |
| `ALLOW_INSECURE` | off | Your confirmation that TLS terminates in front of the process. |
| `MANAGE_WEBHOOKS` | on locally, **off when exposed** | Allow adding/removing webhooks from the page. |
| `UPLOAD_MAX_MB` | `10` | Largest uploaded image. Discord's own cap depends on boost tier. |
| `LOG` | on | Set `0` to write no log file at all. |
| `LOG_FILE` | `DWP.log` | Where the log lives, relative to the app. |
| `LOG_MAX_MB` | `5` | Rotate to `DWP.log.1` at this size. |
| `SCHEDULE_MAX` | `200` | Most scheduled messages that can be queued at once. |
| `SCHEDULE_GRACE_MIN` | `60` | How late a due message may still be sent after downtime. Older ones are marked missed. |
| `TRUST_PROXY` | off | Use `X-Forwarded-For` for rate-limit identity. Only behind a proxy you control. |
| `BLOCK_MENTIONS` | off | Strip `@everyone`/`@here`/role pings from everything sent. |
| `OPEN` | on | Set `0` to stop it opening a browser on startup. |

Real environment variables override `.env`, so container and CI secrets work without a file.

### Running it on a server

The server refuses to bind to a public address over plain HTTP. Put TLS in front of it and set
`ALLOW_INSECURE=1` to acknowledge you've done so:

```bash
# caddy, as an example
caddy reverse-proxy --from poster.example.com --to 127.0.0.1:3000
HOST=0.0.0.0 ALLOW_INSECURE=1 TRUST_PROXY=1 npm start
```

The access token is the *only* thing standing between the internet and your Discord channel. For
anything beyond personal use, put it behind your own SSO/VPN as well, and set `BLOCK_MENTIONS=1`
unless you specifically need pings.

---

## Updating

On startup the app asks GitHub whether a newer tag exists and, if so, prints a notice and shows a
badge in the page header:

```
  ^ update  v1.1.0 is available - you have v1.0.0
            https://github.com/icelogw/Discord-WebHook-Poster/releases/tag/v1.1.0
            run `git pull` to update
```

One request per run, cached six hours. Every failure path is silent by design - offline,
rate-limited, or a private repo answering 404 all mean `nothing to report` rather than an error.

| Variable | Default | Meaning |
|---|---|---|
| `UPDATE_CHECK` | on | Set `0` to never contact GitHub. |
| `UPDATE_REPO` | this repo | Which repo to check, as `owner/name`. |
| `GITHUB_TOKEN` | - | Only needed to check a private repo. |


## Logging

The server keeps an activity log at `DWP.log`, one JSON object per line:

```
{"t":"2026-08-12T07:09:11.461Z","kind":"send","profile":"main","id":"14018…","summary":"Release v2.4.0 is live","payload":{…}}
{"t":"2026-08-12T07:10:02.887Z","kind":"scheduled","profile":"main","due":"2026-08-12T09:00:00.000Z"}
{"t":"2026-08-12T09:00:00.114Z","kind":"send","profile":"main","id":"14019…","scheduled":true,…}
```

It records sends, edits, deletes, scheduled messages firing or missing, and webhook changes -
**including the message content**, which is what lets the **Sent messages** panel be rebuilt from
it. That list therefore survives a cleared browser, and shows messages the scheduler sent while
nothing was open.

Three things never reach the log: **webhook URLs**, the **access token**, and **image bytes** -
uploads are recorded by filename and size only, so one screenshot can't dwarf the whole file.

It rotates at `LOG_MAX_MB` (5 MB) to a single `DWP.log.1`, so it can't grow without bound while
recent history still survives a restart. `LOG=0` turns it off entirely; the Sent panel then falls
back to browser storage.

Note the file holds what you sent, so treat it like `.env` - it's gitignored for that reason.

## What the editor does

- **Markdown toolbar** - bold, italic, underline, strikethrough, spoiler, inline code, code blocks,
  quotes, `H1`–`H3`, subtext, bullet and numbered lists, masked links.
- **Undo/redo across the whole message** - `Ctrl+Z` / `Ctrl+Shift+Z`. See below.
- **Timestamps** - pick a moment, see all seven Discord formats (`t T d D f F R`) rendered live,
  click one to insert its `<t:1700000000:F>` code. Discord shows these in each viewer's own timezone.
- **Embeds** - up to 10, each with title/URL, description, colour, author, thumbnail, image, footer,
  send-time timestamp, and up to 25 fields with inline toggles. Reorder, duplicate, collapse.
- **Polls** - question, up to 10 answers, duration and multi-select.
- **Identity override** - post as a different username and avatar per message.
- **Delivery options** - send silently (no notification), hide link previews, and control who may be
  pinged: everything (Discord's default), nothing, or a custom set - `@everyone`/`@here` plus named
  role and user IDs. These only *permit* mentions that are already in your text; they never add one,
  and the app warns if you allow `@everyone` without writing one.
- **Forum posts** - create a new forum/media thread with a title and tags, as well as posting into
  an existing thread by ID.
- **Components V2** - a second composer mode built from blocks: text, containers with accent
  colours, sections with thumbnails, media galleries of up to 10 images, and dividers.
- **Image upload** - every image field (gallery items, section thumbnails, embed image and
  thumbnail) takes a URL *or* a file from your machine. See below.
- **Edit and delete after sending** - every sent message is remembered with its ID; load one back,
  change it and save in place, or delete it from the channel.
- **Webhook details** - look up the webhook's real name, avatar and channel; rename it, change or
  remove its picture, or delete it permanently. That picture is the webhook's own, as distinct from
  the per-message avatar override.
- **Live preview** - Discord-styled rendering of markdown, embeds, polls and V2 blocks, plus a JSON
  tab showing the exact API payload.
- **Scheduling and recurring sends** - hand a message to the server to send later, once or every
  day/week/month until a date you choose. The queue lives on the server, so it fires whether or not
  a browser is open. Server only - not available in the exe (see below).
- **Templates** - save the whole composed message under a name and load it back later: text,
  embeds, poll, V2 blocks and the delivery settings. The webhook is deliberately not part of a
  template, so the same message can go to a different channel. They are kept in `templates.json`
  beside the app, so they survive a cleared browser and every browser pointed at the server sees
  the same set; anything saved before there was a server is moved into the file on first run.
  Opened straight off disk with no server at all, they fall back to browser storage.
- **Several webhooks at once** - tick any of your other saved webhooks under **Also send to** and
  the same message goes to each. They are sent one at a time, so a dead webhook costs only its own
  send; the result says how many got through and names any that did not. Scheduling fans out the
  same way, one queue entry per target, so each can be cancelled on its own.

<img src="https://github.com/icelogw/Discord-WebHook-Poster/raw/main/docs/also-send-to.png" alt="The Webhook card in server mode: a Post to dropdown naming the primary webhook, and an Also send to row of checkboxes for the others" width="760">

Webhooks are chosen by name, never by URL - this is proxy mode, so the page has never seen the
URLs. A webhook supplied as a real environment variable rather than through `.env` can be sent to
but not removed from here.
- **Limits** - live counters for the 2000-character message cap, per-field caps and the 6000-character
  embed total, all checked before sending.
- **Start over** - empties the composer in one go: text, embeds, poll, blocks and delivery
  settings. Your draft is restored every time the app opens, so this is how you put a finished
  message away rather than editing over it. The webhook and thread ID are left alone, since those
  are where you are sending rather than what, and undo brings the message back.
- **Settings** - the gear in the header. Choose whether your message is remembered between visits,
  whether Send asks first, and which preview tab opens by default; clear the draft, the sent list or
  everything this browser holds; and see what the server decided (mode, version, logging, upload cap,
  scheduling) read-only, since those come from `.env`.
- **A first-run intro** that explains where to get a webhook URL and where things are stored, shown
  once and reachable afterwards from the help dialog.
- **Import/export** - round-trips its own JSON, and also imports a raw Discord webhook payload.

### Keyboard shortcuts

Press `Ctrl+/` in the app for this list, or click the keyboard icon in the header.

| | |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+B` `Ctrl+I` `Ctrl+U` `Ctrl+K` | Bold, italic, underline, masked link |
| `Ctrl+Enter` | Send now |
| `E` `T` `S` `J` | Add embed · timestamp · schedule · JSON view - **only when not typing** |
| `Ctrl+/` · `Esc` | Shortcut list · close a dialog |

Undo covers the message, embeds, fields and the webhook URL - not only the box the caret is in, so
deleting an embed by mistake is recoverable. Rapid typing is grouped into one step (roughly a
400 ms pause starts a new one); structural changes like adding or deleting an embed are always their
own step. History is 80 steps deep and resets when you reload.

The single-key shortcuts deliberately avoid `Ctrl+Shift+…` combinations, because the browser keeps
most of those for itself - `Ctrl+Shift+T` reopens a closed tab and `Ctrl+Shift+J` opens devtools,
and a page cannot override either.

### Composer modes

The **Compose as** switch picks the message format, per message:

- **Text & embeds** - the normal message. Markdown text, up to 10 embeds, optionally a poll.
- **Components V2** - the message is built from blocks instead. Discord does not allow a V2 message
  to also carry message content, embeds or a poll, so those panels hide while it is on; the app
  blocks the combination before sending rather than letting Discord reject it.

Buttons and select menus are **not** offered in either mode: Discord only accepts interactive
components from application-owned webhooks, which a channel webhook is not.

<img src="https://github.com/icelogw/Discord-WebHook-Poster/raw/main/docs/components-v2.png" alt="The Components V2 composer, building a message from a coloured container, text, a divider and a section" width="900">

The app blocks the invalid combinations before sending rather than letting Discord reject them.

### Image upload

Any image field offers **Upload** next to the URL box. Picked files are sent with the message as
attachments and referenced internally as `attachment://filename`; you never have to host them.

- **Images only** - PNG, JPEG, GIF and WebP. This is not a general file-attachment feature: the
  server checks the declared type *and* the file's magic bytes, so renaming `payload.php` to
  `.png` is rejected.
- **10 images and 10 MB per message** by default. Discord's real ceiling depends on the server's
  boost tier; raise `UPLOAD_MAX_MB` if yours allows more.
- **Uploads do not survive a page reload.** A picked file is held in memory - a `File` can't go in
  `localStorage` - so reloading clears it and the field says so rather than silently sending
  nothing. Draft text and embeds still persist as normal.
- **Editing a message replaces its attachments.** Discord treats an edit without an attachment list
  as "remove them all", so re-pick any image you want to keep.
- URLs remain the better choice for anything reused, since attachments are tied to their message.

### Known limits

- **Scheduling and recurring sends need the server, so the exe can't do them.** The packaged
  executable only runs while its window is open, so a queue it owned could not be relied on to fire.
  Rather than pretend, the app disables the feature there and explains why. Run from source if you
  need it. A one-off that came due while the server was down is marked **missed** rather than sent
  late; the grace window is `SCHEDULE_GRACE_MIN`. A *recurring* one skips the occurrences it slept
  through and simply resumes at the next one, so a weekend of downtime does not produce a burst of
  backdated messages.
- **Images only, no other file types** - no logs, archives or documents, and no `File`
  component. That was a deliberate scope choice, not a Discord restriction.
- **Webhook pictures must be PNG, JPEG or GIF**, up to 8 MB - Discord takes them inline as image
  data, and WebP isn't accepted there. The per-message avatar override is separate and takes a URL.
- **Polls can't be edited** once sent, only ended - that's a Discord rule, not an app limit. Editing
  is available for message text, embeds and V2 blocks.
- The sent-message list is read back from the server log, so it survives a cleared browser and
  includes anything the scheduler sent while the page was closed. Opened straight off disk there is
  no server, so it falls back to browser storage. Messages sent from somewhere else entirely still
  won't appear - use **Load by ID** for those.
- Preview markdown is a close approximation, not Discord's exact parser.

---

## Security model (proxy mode)

What the server does, and why:

- **No client-supplied destinations.** The API accepts a profile *name*, never a URL, so it can't be
  turned into a request forwarder (SSRF).
- **Payloads are rebuilt, not forwarded.** Every field is copied through a whitelist, so extra
  webhook parameters (`username`, `avatar_url`, `tts`, `components`, `allowed_mentions`) can't be
  smuggled through by a modified client. Embed image/author/footer URLs must be `http(s)`, which
  rejects `javascript:` and `data:`.
- **Limits are re-checked server-side** - the browser's checks are convenience, not enforcement.
- **Constant-time token comparison**, so the token can't be recovered by timing.
- **JSON content type required + `Origin` checked**, which together block drive-by CSRF - a hostile
  page in your browser can't quietly make your localhost server post to Discord.
- **Rate limited** per client, counting authenticated attempts (not just successes) so the limiter
  can't be probed around. Failed auth doesn't consume anyone's budget.
- **Strict CSP** with a per-response nonce: `default-src 'none'`, no inline handlers anywhere in the
  page, `frame-ancestors 'none'`.
- **A fixed set of routes, no static file serving**, so there is no path-traversal surface.
- **Logs never contain webhook URLs or the token.**
- **Webhook management is disabled by default once exposed** (`MANAGE_WEBHOOKS`), so a token holder
  on a public deployment can't point your server at a channel of their own. Names are validated
  against a strict pattern, so nothing can be injected into `.env` through them.
- **Safe by default**: loopback-only bind, and it refuses to start exposed over plain HTTP.
- **Saved templates are bounded.** `templates.json` is written `0600`, capped at 100 templates,
  256 KB each and 2 MB in total, and written through a temp file that is renamed into place, so an
  interrupted save cannot leave a half-written file. A corrupt one is treated as empty rather than
  taking the server down. What it stores is the composer's own state, never a Discord payload:
  nothing in it reaches Discord without being sent back through `/api/send` and sanitised like any
  other message.

`.env` is gitignored and written `0600`. It holds live credentials - treat it accordingly.
`DWP.log`, `.schedule/` and `templates.json` are gitignored too, since all three hold message
content.

## Requirements

A current browser, and a Discord webhook URL. Nothing else - no Discord account, no bot, no sign-in.

Running from source additionally needs Node 18+ (it uses the built-in `fetch`). The exe needs
nothing at all. There are no dependencies either way.

## Reporting a bug

Open an [issue](https://github.com/icelogw/Discord-WebHook-Poster/issues) and say what happened,
what you expected, and which build you were on - the version is in the header of the app and in
**Settings**. If it involves a message that failed to send, the error the app showed is the useful
part; if you run from source, the console line for that send says more.

Please don't paste a webhook URL into an issue - it is a credential, and anyone reading it could
post to your channel. The webhook's name is enough.

Code contributions aren't accepted: the licence doesn't allow modified copies, so a pull request
isn't something that can be merged. Bug reports and suggestions are genuinely welcome though.

## Licence

**Personal use only - this is not open source.** You may run it for your own private,
non-commercial purposes, including posting to Discord servers you own, run or help moderate. You
may not modify it, redistribute it, or use it commercially. All rights reserved; see
[LICENSE](https://github.com/icelogw/Discord-WebHook-Poster/blob/main/LICENSE.md) for the full
terms.

The packaged exe bundles the Node.js runtime, which carries its own MIT licence - those terms
apply to the runtime, not to this software.

**Not affiliated with Discord.** This is an independent, unofficial tool. "Discord" is a trademark
of Discord Inc., and their API and developer documentation are theirs - nothing here claims any
right over them. Descriptions of how the API behaves are for reference only and may change
whenever Discord changes something. Your use is also subject to Discord's own terms.
