#!/usr/bin/env node
'use strict';
/* =============================================================================
   Discord Webhook Poster - proxy server.
   Zero dependencies, Node 18+ (uses the built-in fetch).

   The point of this server is that the browser never holds a webhook URL.
   The page names a profile ("deploy"); the server maps that to the real URL
   from .env and posts to Discord itself. A stolen browser session therefore
   leaks nothing reusable outside this server.

   Safe by default:
     - binds to 127.0.0.1 unless you deliberately set HOST
     - refuses to start exposed without an access token
     - refuses to start exposed over plain HTTP unless you acknowledge it
     - clients can never supply a destination URL, only a profile name (no SSRF)
     - payloads are rebuilt field by field from a whitelist, not forwarded
     - per-IP and global rate limits
     - JSON-only + Origin check, which blocks drive-by CSRF from other sites
     - strict CSP with a per-response nonce
   ========================================================================== */

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

/* When packaged as a single executable, index.html and package.json are baked in
   as assets and __dirname points inside the bundle - so anything on disk, .env in
   particular, is resolved next to the exe instead. Unbundled, this is a no-op. */
let sea = null;
try { sea = require('node:sea'); } catch { /* Node < 20.12 has no node:sea */ }
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

const ROOT    = IS_SEA ? path.dirname(process.execPath) : __dirname;
const ENVFILE = path.join(ROOT, '.env');
const PAGE    = path.join(ROOT, 'index.html');

/* Prefer the embedded copy; fall back to disk so a modified index.html dropped
   next to the exe still works. */
function readAsset(name, onDisk) {
  if (IS_SEA) {
    try { return sea.getAsset(name, 'utf8'); } catch {}
  }
  return fs.readFileSync(onDisk, 'utf8');
}

/* -------------------------------------------------------------------- env */
function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
/* real environment wins over the file, so container/CI secrets override .env */
const FILE_ENV = parseEnv(ENVFILE);
const ENV = Object.assign({}, FILE_ENV, process.env);

/* Rewrite a single key in .env, leaving every other line (and the comments) alone.
   `value === null` deletes the line. Keys are validated by the caller. */
function writeEnvKey(key, value) {
  let text = fs.existsSync(ENVFILE) ? fs.readFileSync(ENVFILE, 'utf8') : '';
  const re = new RegExp('^[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=.*(?:\\r?\\n)?', 'm');
  if (value === null) text = text.replace(re, '');
  else if (re.test(text)) text = text.replace(re, key + '=' + value + '\n');
  else text = text + (text && !text.endsWith('\n') ? '\n' : '') + key + '=' + value + '\n';
  fs.writeFileSync(ENVFILE, text, { mode: 0o600 });
  try { fs.chmodSync(ENVFILE, 0o600); } catch {}
}

const PORT        = parseInt(ENV.PORT || '3000', 10);
const HOST        = ENV.HOST || '127.0.0.1';
/* Fixed on purpose. Discord's own webhook limit is around 30 sends per minute,
   so raising this only moves the rejection from here to there, and lowering it
   is not a security control - anyone holding the token could raise it back. */
const RATE_PER_MIN = 20;
const TRUST_PROXY = /^(1|true|yes)$/i.test(ENV.TRUST_PROXY || '');
const INSECURE_OK = /^(1|true|yes)$/i.test(ENV.ALLOW_INSECURE || '');
const BLOCK_PINGS = /^(1|true|yes)$/i.test(ENV.BLOCK_MENTIONS || '');
const OPEN_BROWSER= !/^(0|false|no)$/i.test(ENV.OPEN || '1');

const isLoopback = h => ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(h);
const EXPOSED    = !isLoopback(HOST);

/* ------------------------------------------------------------ update check
   Asks GitHub once per run whether a newer tag exists. Entirely optional and
   entirely silent on failure: a private repo answers 404 to anonymous callers,
   which is treated as "nothing to report" rather than an error. */
const UPDATE_REPO  = (ENV.UPDATE_REPO || 'icelogw/Discord-WebHook-Poster').trim();
const UPDATE_ON    = !/^(0|false|no)$/i.test(ENV.UPDATE_CHECK || '1');
const UPDATE_EVERY = 6 * 3600 * 1000;

function readVersion() {
  try {
    return JSON.parse(readAsset('package.json', path.join(ROOT, 'package.json'))).version || '0.0.0';
  } catch { return '0.0.0'; }
}
const VERSION = readVersion();

/* Console colours, and nothing at all when the output is not a terminal - piped
   into a file or a CI log, escape codes are just noise. NO_COLOR is honoured
   because it is the convention every other CLI follows. */
const COLOUR = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const c = s => COLOUR ? s : '';
const CLR = {
  off:  c('\x1b[0m'),
  bold: c('\x1b[1m'),
  dim:  c('\x1b[2m'),
  link: c('\x1b[36m'),      /* cyan - the one line worth spotting at a glance */
  warn: c('\x1b[33m'),
  ok:   c('\x1b[32m'),
  err:  c('\x1b[31m')
};

/* Compare dotted numeric versions; any -pre suffix sorts below the release. */
function cmpVer(a, b) {
  const parts = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  const pre = v => /-/.test(String(v));
  if (pre(a) !== pre(b)) return pre(a) ? -1 : 1;
  return 0;
}

let updateInfo = null;      /* {current, latest, url, available} | null */
let updateAt   = 0;
let updating   = null;

function checkUpdate() {
  if (!UPDATE_ON) return Promise.resolve(null);
  if (updating) return updating;
  if (Date.now() - updateAt < UPDATE_EVERY) return Promise.resolve(updateInfo);

  updating = (async () => {
    const headers = { 'User-Agent': 'discord-webhook-poster/' + VERSION,
                      'Accept': 'application/vnd.github+json' };
    if (ENV.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + ENV.GITHUB_TOKEN;
    const api = 'https://api.github.com/repos/' + UPDATE_REPO;
    const get = u => fetch(u, { headers, signal: AbortSignal.timeout(8000) });

    try {
      let tag = null, assets = [], url = 'https://github.com/' + UPDATE_REPO + '/releases';
      let r = await get(api + '/releases/latest');
      if (r.ok) {
        const j = await r.json();
        tag = j.tag_name; url = j.html_url || url;
        assets = (j.assets || []).map(a => ({ name: a.name, size: a.size,
                                              url: a.browser_download_url }));
      } else if (r.status === 404) {
        /* no formal releases - fall back to plain tags */
        r = await get(api + '/tags?per_page=1');
        if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j[0]) tag = j[0].name; }
      }
      updateInfo = tag
        ? { current: VERSION, latest: String(tag).replace(/^v/i, ''), url, assets,
            available: cmpVer(tag, VERSION) > 0 }
        : null;
    } catch {
      updateInfo = null;               /* offline, rate-limited, private - all fine */
    }
    updateAt = Date.now();
    updating = null;
    return updateInfo;
  })();
  return updating;
}

/* ================================================================= LOG FILE
   One JSON object per line, so it is both readable by eye and parseable back -
   the Sent-messages panel is rebuilt from this, which is why it keeps the
   message content rather than just a note that something was sent.

   Never written here: webhook URLs, the access token, or image bytes. Uploads
   are recorded by name and size only, otherwise a single 10 MB screenshot would
   dwarf the entire log. */
const LOG_ON   = !/^(0|false|no)$/i.test(ENV.LOG || '1');
const LOG_FILE = ENV.LOG_FILE ? path.resolve(ROOT, ENV.LOG_FILE) : path.join(ROOT, 'DWP.log');
const LOG_MAX  = Math.max(1, parseInt(ENV.LOG_MAX_MB || '5', 10)) * 1024 * 1024;

function logRotate() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < LOG_MAX) return;
    fs.rmSync(LOG_FILE + '.1', { force: true });
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* a locked or unwritable file must never break a send */ }
}

function logEvent(kind, fields = {}) {
  if (!LOG_ON) return;
  try {
    logRotate();
    fs.appendFileSync(LOG_FILE,
      JSON.stringify({ t: new Date().toISOString(), kind, ...fields }) + '\n',
      { mode: 0o600 });
  } catch { /* logging is never worth failing a request over */ }
}

/* Uploads are summarised, never stored. */
const logFiles = files => (files || []).map(f => ({ name: f.name, bytes: f.buf ? f.buf.length : 0 }));

/* Read the log back, newest first. Reads the rotated file too so history
   survives a rotation. */
function logRead(filter, limit = 200) {
  const out = [];
  for (const file of [LOG_FILE, LOG_FILE + '.1']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }   /* torn final line */
      if (!filter || filter(row)) out.push(row);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/* Adding webhooks from the page rewrites .env. That is convenient on your own machine
   and a liability on an exposed host, where anyone holding the token could point the
   server at a channel of their own. So: on by default locally, off by default exposed. */
const MANAGE = ENV.MANAGE_WEBHOOKS != null
  ? /^(1|true|yes)$/i.test(ENV.MANAGE_WEBHOOKS)
  : !EXPOSED;

const WEBHOOK_RE =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

/* ------------------------------------------------------- webhook profiles */
/* Every WEBHOOK_<name>=<url> in .env becomes a profile the page can pick by name.
   Values are kept server-side; only the names are ever sent to a browser. */
const profiles = new Map();          /* name -> { url, key, fromProcessEnv } */

const keyToName = k => (k === 'WEBHOOK_URL' ? 'default'
                                            : k.slice(8).toLowerCase().replace(/_/g, '-'));
const nameToKey = n => 'WEBHOOK_' + n.toUpperCase().replace(/-/g, '_');
const NAME_RE   = /^[a-z0-9][a-z0-9-]{0,31}$/;

for (const [k, v] of Object.entries(ENV)) {
  if (!/^WEBHOOK_.+$/.test(k)) continue;
  const url = String(v).trim();
  if (!url) continue;
  if (!WEBHOOK_RE.test(url)) {
    console.error('  ✖ ' + k + ' is not a valid Discord webhook URL - refusing to start.');
    process.exit(1);
  }
  profiles.set(keyToName(k), { url, key: k, fromProcessEnv: k in process.env });
}

/* Tell the user an update exists. Installing it is `git pull` - there is no
   self-updating binary to swap in. */
function offerUpdate(info) {
  if (!info || !info.available) return;
  console.log('\n  ' + CLR.warn + 'update' + CLR.off + '  v' + info.latest
              + ' is available - you have v' + info.current);
  console.log('          ' + CLR.link + info.url + CLR.off);
  console.log('          ' + CLR.dim + 'run `git pull` to update' + CLR.off + '\n');
}

/* ------------------------------------------------------------------ token */
let TOKEN = (ENV.AUTH_TOKEN || '').trim();
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url');
  try {
    const prev = fs.existsSync(ENVFILE) ? fs.readFileSync(ENVFILE, 'utf8') : '';
    const sep = prev && !prev.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ENVFILE, prev + sep + '\n# generated automatically on first run\nAUTH_TOKEN=' + TOKEN + '\n',
                     { mode: 0o600 });
    try { fs.chmodSync(ENVFILE, 0o600); } catch {}
    console.log('\n  ' + CLR.ok + '+' + CLR.off + ' generated an access token and saved it to .env');
  } catch (e) {
    console.log('\n  ' + CLR.warn + '!' + CLR.off
                + ' generated a temporary access token (could not write .env: ' + e.message + ')');
  }
}
const TOKEN_BUF = Buffer.from(TOKEN);

function tokenOk(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  /* timingSafeEqual throws on a length mismatch, so compare lengths first -
     the length of a token is not a useful secret */
  return got.length === TOKEN_BUF.length && crypto.timingSafeEqual(got, TOKEN_BUF);
}

/* ------------------------------------------------------- startup guardrails */
if (EXPOSED && !INSECURE_OK) {
  console.error('\n  ✖ HOST is set to ' + HOST + ', which exposes this server beyond localhost.');
  console.error('    Anyone who can reach it and holds the token can post to your Discord,');
  console.error('    and plain HTTP would send that token across the network in the clear.');
  console.error('\n    Put it behind a TLS-terminating reverse proxy (caddy/nginx/cloudflared),');
  console.error('    then set ALLOW_INSECURE=1 to confirm you have done so.\n');
  process.exit(1);
}

/* ------------------------------------------------------------ rate limiting */
const buckets = new Map();
setInterval(() => {                         /* forget idle clients */
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
}, 60_000).unref();

function rateOk(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_PER_MIN, ts: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.ts) / 60_000) * RATE_PER_MIN);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ----------------------------------------------------- payload sanitising */
const LIM = { content: 2000, embeds: 10, title: 256, desc: 4096, fields: 25,
              fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, total: 6000 };

const str = v => (typeof v === 'string' ? v : '');
const okUrl = v => typeof v === 'string' && /^https:\/\/|^http:\/\//i.test(v) && v.length <= 2048;
const snowflake = v => /^\d{1,25}$/.test(String(v));

/* Uploaded images are referenced as attachment://<filename> inside the payload. */
const ATTACH_RE = /^attachment:\/\/([\w.\-]{1,80})$/i;
const okMedia = v => okUrl(v) || (typeof v === 'string' && ATTACH_RE.test(v));

/* Images only - this is deliberately not a general file-attachment feature.
   Each type is checked by magic bytes as well as declared MIME type. */
const IMG_SIG = {
  'image/png':  [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif':  [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]]              /* RIFF….WEBP */
};
const UPLOAD_MAX = Math.max(1, parseInt(ENV.UPLOAD_MAX_MB || '10', 10)) * 1024 * 1024;
const BODY_MAX   = Math.round(UPLOAD_MAX * 1.4) + 2 * 1024 * 1024;   /* base64 overhead */

function cleanFiles(input, errs) {
  if (!Array.isArray(input) || !input.length) return [];
  if (input.length > 10) { errs.push('At most 10 images per message.'); return []; }

  const out = [], used = new Set();
  let total = 0;
  for (const f of input) {
    if (!f || typeof f !== 'object') continue;
    const type = str(f.type).toLowerCase();
    if (!IMG_SIG[type]) {
      errs.push('Only PNG, JPEG, GIF and WebP images can be uploaded.');
      continue;
    }
    let name = str(f.name).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image';
    if (!/\.[a-z0-9]{1,5}$/i.test(name))
      name += '.' + (type === 'image/jpeg' ? 'jpg' : type.split('/')[1]);
    while (used.has(name)) name = name.replace(/(\.[^.]*)$/, '_' + used.size + '$1');
    used.add(name);

    let buf;
    try { buf = Buffer.from(str(f.data), 'base64'); }
    catch { errs.push('Could not decode ' + name + '.'); continue; }

    if (!buf.length) { errs.push(name + ' is empty.'); continue; }
    if (buf.length > UPLOAD_MAX) {
      errs.push(name + ' is larger than ' + (UPLOAD_MAX / 1048576) + ' MB.');
      continue;
    }
    /* declared type must match the actual bytes */
    if (!IMG_SIG[type].some(sig => sig.every((b, i) => buf[i] === b))) {
      errs.push(name + ' is not really a ' + type.split('/')[1].toUpperCase() + ' image.');
      continue;
    }
    total += buf.length;
    out.push({ name, type, buf });
  }
  if (total > UPLOAD_MAX)
    errs.push('Uploads total ' + (total / 1048576).toFixed(1) + ' MB; the limit is ' +
              (UPLOAD_MAX / 1048576) + ' MB per message.');
  return out;
}

/* Every attachment:// reference anywhere in the payload. */
function attachRefs(o, out = new Set()) {
  if (!o || typeof o !== 'object') return out;
  for (const v of Object.values(o)) {
    if (typeof v === 'string') { const m = ATTACH_RE.exec(v); if (m) out.add(m[1]); }
    else attachRefs(v, out);
  }
  return out;
}

/* Message flags a webhook may set. Anything else is dropped. */
const FLAG = { SUPPRESS_EMBEDS: 4, SUPPRESS_NOTIFICATIONS: 4096, IS_COMPONENTS_V2: 32768 };
const FLAG_MASK = FLAG.SUPPRESS_EMBEDS | FLAG.SUPPRESS_NOTIFICATIONS | FLAG.IS_COMPONENTS_V2;

/* Components V2 - display types only. Buttons and menus (type 1/2/3…) are
   deliberately absent: a channel webhook cannot send them at all. */
const C = { SECTION: 9, TEXT: 10, THUMB: 11, GALLERY: 12, SEPARATOR: 14, CONTAINER: 17 };

function cleanComponents(input, errs, depth = 0) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const c of input) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case C.TEXT: {
        const content = str(c.content);
        if (!content) break;
        out.push({ type: C.TEXT, content });
        break;
      }
      case C.SEPARATOR:
        out.push({ type: C.SEPARATOR, divider: c.divider !== false,
                   spacing: c.spacing === 2 ? 2 : 1 });
        break;
      case C.GALLERY: {
        const items = (Array.isArray(c.items) ? c.items : [])
          .filter(i => i && okMedia(i.media?.url))
          .slice(0, 10)
          .map(i => {
            const o = { media: { url: i.media.url } };
            if (str(i.description)) o.description = str(i.description);
            if (i.spoiler) o.spoiler = true;
            return o;
          });
        if (!items.length) { errs.push('A media gallery needs at least one valid image URL.'); break; }
        out.push({ type: C.GALLERY, items });
        break;
      }
      case C.SECTION: {
        const text = (Array.isArray(c.components) ? c.components : [])
          .filter(t => t && t.type === C.TEXT && str(t.content))
          .slice(0, 3)
          .map(t => ({ type: C.TEXT, content: str(t.content) }));
        if (!text.length) break;
        const o = { type: C.SECTION, components: text };
        if (c.accessory && okMedia(c.accessory.media?.url)) {
          o.accessory = { type: C.THUMB, media: { url: c.accessory.media.url } };
          if (str(c.accessory.description)) o.accessory.description = str(c.accessory.description);
          if (c.accessory.spoiler) o.accessory.spoiler = true;
        } else {
          errs.push('A section needs a thumbnail image URL.');
          break;
        }
        out.push(o);
        break;
      }
      case C.CONTAINER: {
        if (depth > 0) { errs.push('Containers cannot be nested.'); break; }
        const kids = cleanComponents(c.components, errs, depth + 1);
        if (!kids.length) break;
        const o = { type: C.CONTAINER, components: kids };
        if (c.accent_color != null) {
          const n = Number(c.accent_color);
          if (Number.isInteger(n) && n >= 0 && n <= 0xffffff) o.accent_color = n;
        }
        if (c.spoiler) o.spoiler = true;
        out.push(o);
        break;
      }
      default:
        errs.push('Unsupported component type ' + JSON.stringify(c.type) + '.');
    }
  }
  return out;
}

/* Count every component, nested ones included - Discord caps a message at 40. */
const countComponents = list => list.reduce(
  (n, c) => n + 1 + (Array.isArray(c.components) ? countComponents(c.components) : 0), 0);

function cleanPoll(input, errs) {
  if (!input || typeof input !== 'object') return null;
  const question = str(input.question?.text).trim();
  if (!question) { errs.push('A poll needs a question.'); return null; }
  if (question.length > 300) errs.push('Poll question is over 300 characters.');

  const answers = (Array.isArray(input.answers) ? input.answers : [])
    .map(a => str(a?.poll_media?.text).trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(text => {
      if (text.length > 55) errs.push('A poll answer is over 55 characters.');
      return { poll_media: { text } };
    });
  if (answers.length < 2) { errs.push('A poll needs at least two answers.'); return null; }

  const hours = Number(input.duration);
  const o = {
    question: { text: question },
    answers,
    duration: Number.isFinite(hours) ? Math.min(Math.max(Math.round(hours), 1), 768) : 24,
    allow_multiselect: !!input.allow_multiselect,
    layout_type: 1
  };
  return o;
}

function cleanMentions(input) {
  if (!input || typeof input !== 'object') return null;
  const parse = (Array.isArray(input.parse) ? input.parse : [])
    .filter(p => ['everyone', 'roles', 'users'].includes(p));
  const o = { parse };
  const roles = (Array.isArray(input.roles) ? input.roles : []).filter(snowflake).slice(0, 100);
  const users = (Array.isArray(input.users) ? input.users : []).filter(snowflake).slice(0, 100);
  /* Discord rejects a parse entry alongside an explicit list of the same kind */
  if (roles.length && !parse.includes('roles')) o.roles = roles;
  if (users.length && !parse.includes('users')) o.users = users;
  return o;
}

/* Rebuild the payload key by key. Nothing the client sends is forwarded verbatim,
   so unknown webhook parameters cannot be smuggled through. */
function cleanPayload(input) {
  const errs = [];
  const out = {};
  if (!input || typeof input !== 'object') return { errs: ['Malformed payload.'] };

  const content = str(input.content);
  if (content.length > LIM.content) errs.push('Content exceeds ' + LIM.content + ' characters.');
  if (content) out.content = content;

  const embedsIn = Array.isArray(input.embeds) ? input.embeds : [];
  if (embedsIn.length > LIM.embeds) errs.push('More than ' + LIM.embeds + ' embeds.');

  let total = 0;
  const embeds = [];
  for (const [i, e] of embedsIn.entries()) {
    if (!e || typeof e !== 'object') continue;
    const o = {}, tag = 'Embed ' + (i + 1) + ': ';

    const title = str(e.title);
    if (title.length > LIM.title) errs.push(tag + 'title too long.');
    if (title) o.title = title;

    const desc = str(e.description);
    if (desc.length > LIM.desc) errs.push(tag + 'description too long.');
    if (desc) o.description = desc;

    if (e.url) { if (okUrl(e.url)) o.url = e.url; else errs.push(tag + 'invalid title URL.'); }

    if (e.color != null) {
      const c = Number(e.color);
      if (!Number.isInteger(c) || c < 0 || c > 0xffffff) errs.push(tag + 'invalid colour.');
      else o.color = c;
    }
    if (e.timestamp) {
      const d = new Date(e.timestamp);
      if (isNaN(d.getTime())) errs.push(tag + 'invalid timestamp.');
      else o.timestamp = d.toISOString();
    }
    if (e.author && typeof e.author === 'object' && str(e.author.name)) {
      const name = str(e.author.name);
      if (name.length > LIM.author) errs.push(tag + 'author name too long.');
      o.author = { name };
      if (e.author.url && okUrl(e.author.url)) o.author.url = e.author.url;
      if (e.author.icon_url && okUrl(e.author.icon_url)) o.author.icon_url = e.author.icon_url;
    }
    if (e.footer && typeof e.footer === 'object' && str(e.footer.text)) {
      const text = str(e.footer.text);
      if (text.length > LIM.footer) errs.push(tag + 'footer too long.');
      o.footer = { text };
      if (e.footer.icon_url && okUrl(e.footer.icon_url)) o.footer.icon_url = e.footer.icon_url;
    }
    if (e.thumbnail?.url && okMedia(e.thumbnail.url)) o.thumbnail = { url: e.thumbnail.url };
    if (e.image?.url     && okMedia(e.image.url))     o.image     = { url: e.image.url };

    const fieldsIn = Array.isArray(e.fields) ? e.fields : [];
    if (fieldsIn.length > LIM.fields) errs.push(tag + 'too many fields.');
    const fields = [];
    for (const f of fieldsIn) {
      if (!f || typeof f !== 'object') continue;
      const name = str(f.name), value = str(f.value);
      if (!name && !value) continue;
      if (name.length > LIM.fieldName)  errs.push(tag + 'field name too long.');
      if (value.length > LIM.fieldValue) errs.push(tag + 'field value too long.');
      fields.push({ name: name || '​', value: value || '​', inline: !!f.inline });
      total += name.length + value.length;
    }
    if (fields.length) o.fields = fields;

    total += title.length + desc.length +
             (o.footer?.text.length || 0) + (o.author?.name.length || 0);

    const renders = o.title || o.description || o.author || o.footer ||
                    o.image || o.thumbnail || o.fields;
    if (renders) embeds.push(o);
  }
  if (total > LIM.total) errs.push('Embed text totals ' + total + ' / ' + LIM.total + ' characters.');
  if (embeds.length) out.embeds = embeds;

  /* ---- identity override ---- */
  const username = str(input.username).trim();
  if (username) {
    if (username.length > 80) errs.push('Username override is over 80 characters.');
    /* Discord rejects these outright, so fail loudly rather than have it 400 upstream */
    if (/discord/i.test(username)) errs.push('Username override cannot contain "discord".');
    out.username = username;
  }
  if (input.avatar_url) {
    if (okUrl(input.avatar_url)) out.avatar_url = input.avatar_url;
    else errs.push('Avatar URL must be http(s).');
  }
  if (input.tts) out.tts = true;

  /* ---- flags ---- */
  const flags = Number(input.flags) || 0;
  const kept = flags & FLAG_MASK;
  if (kept) out.flags = kept;
  const isV2 = !!(kept & FLAG.IS_COMPONENTS_V2);

  /* ---- components (V2) ---- */
  if (Array.isArray(input.components) && input.components.length) {
    const comps = cleanComponents(input.components, errs);
    if (comps.length) {
      const n = countComponents(comps);
      if (n > 40) errs.push('Components V2 allows 40 components per message; this has ' + n + '.');
      out.components = comps;
    }
  }

  /* ---- poll ---- */
  if (input.poll) {
    const poll = cleanPoll(input.poll, errs);
    if (poll) out.poll = poll;
  }

  /* ---- forum / thread creation ---- */
  const threadName = str(input.thread_name).trim();
  if (threadName) {
    if (threadName.length > 100) errs.push('Thread name is over 100 characters.');
    out.thread_name = threadName;
  }
  const tags = (Array.isArray(input.applied_tags) ? input.applied_tags : [])
    .map(String).filter(snowflake).slice(0, 5);
  if (tags.length) out.applied_tags = tags;

  /* ---- mutual exclusions Discord enforces, checked here so the error is legible ---- */
  if (isV2) {
    if (out.content)  errs.push('A Components V2 message cannot also have message content.');
    if (out.embeds)   errs.push('A Components V2 message cannot also have embeds.');
    if (out.poll)     errs.push('A Components V2 message cannot also have a poll.');
    if (!out.components) errs.push('Components V2 is enabled but there are no components.');
  } else if (out.components) {
    errs.push('Components require the Components V2 flag.');
  }

  if (!out.content && !out.embeds && !out.components && !out.poll) errs.push('Nothing to send.');

  /* ---- mentions ---- */
  const mentions = cleanMentions(input.allowed_mentions);
  if (mentions) out.allowed_mentions = mentions;
  /* opt-in guard against a webhook being used to mass-ping - always wins */
  if (BLOCK_PINGS) out.allowed_mentions = { parse: [] };

  return { payload: out, errs };
}

/* ------------------------------------------------------------------ helpers */
function send(res, status, body, extra = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, extra));
  res.end(data);
}

const TOO_BIG = () => Object.assign(new Error('Payload too large'), { status: 413 });

/* Over-limit bodies are discarded but still drained to the end of the request.
   Answering mid-upload and hanging up would reset the connection under HTTP/1.1
   and the caller would see ECONNRESET instead of the 413. A client that keeps
   streaming past DRAIN_CAP is treated as abusive and does get hung up on. */
function readBody(req, limit = 256 * 1024, drainCap = limit + 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    let chunks = [];
    req.on('data', c => {
      size += c.length;
      if (!over && size > limit) { over = true; chunks = []; }
      if (over) { if (size > drainCap) req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => over ? reject(TOO_BIG())
                             : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', e => reject(over ? TOO_BIG() : e));
  });
}

/* Reject cross-site requests. Combined with the required JSON content type this
   closes the drive-by CSRF hole a localhost server would otherwise have. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                     /* non-browser client (curl, CI) */
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

/* ------------------------------------------------------------------- routes */
/* Shared front door for every /api call: same-origin, JSON, authenticated. */
function gate(req, res, { json = false } = {}) {
  if (!sameOrigin(req)) { send(res, 403, { error: 'Cross-origin request refused.' }); return false; }
  if (json && !(req.headers['content-type'] || '').includes('application/json')) {
    send(res, 415, { error: 'Expected Content-Type: application/json.' }); return false;
  }
  if (!tokenOk(req.headers.authorization)) {
    send(res, 401, { error: 'Invalid or missing access token.' }); return false;
  }
  return true;
}

const profileList = () => [...profiles.keys()].sort();

/* Add or replace a webhook from the UI. The URL is stored in .env and never sent back. */
async function handleAddProfile(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!MANAGE) return send(res, 403, {
    error: 'Managing webhooks from the browser is disabled on this server. Add WEBHOOK_ lines to .env instead.' });
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const name = String(body.name || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const url  = String(body.url || '').trim();

  if (!NAME_RE.test(name)) return send(res, 400, {
    error: 'Name must be 1–32 characters: lowercase letters, numbers and dashes, starting with a letter or number.' });
  if (!WEBHOOK_RE.test(url)) return send(res, 400, {
    error: 'That is not a Discord webhook URL. Expected https://discord.com/api/webhooks/<id>/<token>' });

  const existing = profiles.get(name);
  if (existing?.fromProcessEnv) return send(res, 409, {
    error: '"' + name + '" is set by an environment variable and cannot be changed here.' });

  /* Ask Discord whether it is real before writing it down. A URL can be the right
     shape and still be dead - a typo in the token, or a webhook deleted since it
     was copied - and finding that out on your first send is too late. */
  const check = await callDiscord(url, { method: 'GET' });
  /* callDiscord reports every upstream failure as 502 and keeps Discord's own
     code in the tag, so a dead webhook is discord-404, not status 404. */
  if (/^discord-(401|403|404)$/.test(check.tag || ''))
    return send(res, 400, { error: 'Discord does not recognise that webhook. Check you copied the '
                                 + 'whole URL, and that it has not been deleted.' });

  const key = existing?.key || nameToKey(name);
  try { writeEnvKey(key, url); }
  catch (e) { return send(res, 500, { error: 'Could not write .env: ' + e.message }); }

  profiles.set(name, { url, key, fromProcessEnv: false });
  log(ip, 'profile', existing ? 'updated' : 'added', name);
  logEvent('webhook-' + (existing ? 'updated' : 'added'), { profile: name });
  /* What Discord said it is, so the page can confirm the right channel. Absent
     when Discord could not be reached - the webhook is saved either way, since
     refusing to save because our network blinked would be worse. */
  const info = check.ok && check.data ? { name: check.data.name || '', channelId: check.data.channel_id || '' } : null;
  return send(res, 200, { ok: true, name, profiles: profileList(), verified: !!check.ok, info });
}

async function handleDeleteProfile(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!MANAGE) return send(res, 403, { error: 'Managing webhooks from the browser is disabled on this server.' });
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const name = String(body.name || '').trim().toLowerCase();
  const entry = profiles.get(name);
  if (!entry) return send(res, 404, { error: 'No webhook named "' + name + '".' });
  if (entry.fromProcessEnv) return send(res, 409, {
    error: '"' + name + '" is set by an environment variable and cannot be removed here.' });

  try { writeEnvKey(entry.key, null); }
  catch (e) { return send(res, 500, { error: 'Could not write .env: ' + e.message }); }

  profiles.delete(name);
  log(ip, 'profile', 'removed', name);
  logEvent('webhook-removed', { profile: name });
  return send(res, 200, { ok: true, profiles: profileList() });
}

async function handleSend(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!rateOk(ip))
    return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;   /* hung up on an abusive client */
    return e.status === 413
      ? send(res, 413, { error: 'Request body too large.' })
      : send(res, 400, { error: 'Could not read the request body.' });
  }

  const entry = profiles.get(String(body.profile || ''));
  if (!entry) return send(res, 400, { error: 'Unknown webhook profile.' });
  const url = entry.url;

  const { payload, errs } = cleanPayload(body.payload);
  const files = cleanFiles(body.files, errs);
  if (errs.length) return send(res, 400, { error: errs.join(' ') });
  const attachErr = applyAttachments(payload, files);
  if (attachErr) return send(res, 400, { error: attachErr });

  const query = { wait: 'true' };
  const thread = String(body.threadId || '').trim();
  if (thread) {
    if (!snowflake(thread)) return send(res, 400, { error: 'Invalid thread ID.' });
    query.thread_id = thread;
  }
  /* a non-application webhook must opt in explicitly for components to be honoured */
  if (payload.flags & FLAG.IS_COMPONENTS_V2) query.with_components = 'true';

  const r = await callDiscord(url, { method: 'POST', body: payload, files, query });
  log(ip, 'send ' + body.profile + (files.length ? ' +' + files.length + 'img' : ''), r.tag);
  logEvent(r.ok ? 'send' : 'send-failed', {
    profile: body.profile, thread: thread || null, id: r.id || null,
    summary: schedSummarise(payload), payload, files: logFiles(files),
    error: r.ok ? undefined : r.error
  });
  return r.ok ? send(res, 200, { ok: true, id: r.id, data: r.data })
              : send(res, r.status, { error: r.error });
}

/* ------------------------------------------------------------------ upstream
   One place that talks to Discord: builds the URL, retries once on a rate
   limit, and translates the response into our own shape. */
/* Performs the call and hands back a plain result. Used by the request handlers
   and by the scheduler, which has no HTTP response to write to. */
async function callDiscord(url, { method = 'GET', body = null, files = null, query = {} } = {}) {
  const target = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v != null) target.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    let up;
    try {
      const init = { method, signal: AbortSignal.timeout(files?.length ? 60_000 : 15_000) };
      if (files && files.length) {
        /* multipart: the payload rides along as payload_json, images as files[n].
           No Content-Type header - fetch must set its own multipart boundary. */
        const fd = new FormData();
        fd.append('payload_json', JSON.stringify(body || {}));
        files.forEach((f, i) =>
          fd.append('files[' + i + ']', new Blob([f.buf], { type: f.type }), f.name));
        init.body = fd;
      } else if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      up = await fetch(target, init);
    } catch (e) {
      return { ok: false, status: 502, tag: 'upstream-error',
               error: 'Could not reach Discord: ' + e.message };
    }

    if (up.status === 429 && attempt === 0) {
      let wait = 1;
      try { wait = (await up.json()).retry_after ?? 1; } catch {}
      await new Promise(r => setTimeout(r, Math.min(Math.max(wait, 0.5), 10) * 1000));
      continue;
    }
    if (!up.ok) {
      let msg = up.status + ' ' + up.statusText;
      try { const j = await up.json(); if (j.message) msg += ' - ' + j.message; } catch {}
      return { ok: false, status: 502, tag: 'discord-' + up.status, error: msg };
    }
    const data = up.status === 204 ? null : await up.json().catch(() => null);
    return { ok: true, status: 200, tag: 'ok', id: data?.id || null, data };
  }
  return { ok: false, status: 429, tag: 'rate-limited',
           error: 'Discord rate limited this webhook. Try again shortly.' };
}

async function forward(res, ip, label, url, opts) {
  const r = await callDiscord(url, opts);
  log(ip, label, r.tag);
  return r.ok ? send(res, 200, { ok: true, id: r.id, data: r.data })
              : send(res, r.status, { error: r.error });
}

/* ========================================================== SCHEDULED SENDS
   The queue lives on disk and the server fires it, so a scheduled message goes
   out whether or not a browser is open. Deliberately unavailable in the
   packaged exe: that is a desktop app you close, so a scheduler that only runs
   while it happens to be open would promise more than it can keep. The page is
   told, and disables the feature rather than pretending.

   One JSON file per item under .schedule/ - keeps a stalled 10 MB upload from
   bloating a single shared file, and makes deleting an item a single unlink. */
const SCHEDULING = !IS_SEA;
const SCHED_DIR  = path.join(ROOT, '.schedule');
const SCHED_MAX  = parseInt(ENV.SCHEDULE_MAX || '200', 10);
/* How late is too late. If the server was down when an item came due, firing a
   week-old announcement is worse than not firing it. */
const SCHED_GRACE = Math.max(1, parseInt(ENV.SCHEDULE_GRACE_MIN || '60', 10)) * 60_000;

let schedTimer = null;

/* ------------------------------------------------------------- recurrence
   A repeating item keeps its time of day and rolls forward after each send.
   Date arithmetic is done in local time on purpose: "every Friday at 09:00"
   should stay at 09:00 across a daylight-saving change, which adding a fixed
   number of milliseconds would not do. */
const REPEATS = ['daily', 'weekly', 'monthly'];

function nextOccurrence(from, repeat) {
  const d = new Date(from);
  if (repeat === 'daily')   d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly')  d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') {
    /* clamp so the 31st does not skip February - it lands on the last day */
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else return null;
  return d.getTime();
}

/* Roll past every occurrence already gone by, so a server that was off for a
   week fires once when it comes back rather than once per missed day. */
function advancePast(at, repeat, now) {
  let next = at;
  for (let i = 0; i < 4000 && next <= now; i++) {
    const t = nextOccurrence(next, repeat);
    if (t === null) return null;
    next = t;
  }
  return next > now ? next : null;
}

const schedPath = id => path.join(SCHED_DIR, id + '.json');
const schedId   = () => Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

function schedLoad() {
  if (!fs.existsSync(SCHED_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SCHED_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(SCHED_DIR, f), 'utf8'))); }
    catch { /* unreadable item - leave the file alone rather than lose it silently */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

function schedWrite(item) {
  fs.mkdirSync(SCHED_DIR, { recursive: true });
  fs.writeFileSync(schedPath(item.id), JSON.stringify(item), { mode: 0o600 });
}
function schedRemove(id) {
  try { fs.rmSync(schedPath(id), { force: true }); } catch {}
}

/* What the browser is allowed to see: never the webhook URL, never the file bytes. */
const schedPublic = i => ({
  id: i.id, at: i.at, profile: i.profile, threadId: i.threadId || '',
  status: i.status, error: i.error || null, summary: i.summary,
  attachments: (i.files || []).length,
  repeat: i.repeat || null, until: i.until || null, sentCount: i.sentCount || 0
});

function schedSummarise(payload) {
  if (payload.content) return payload.content.replace(/\s+/g, ' ').slice(0, 80);
  if (payload.embeds?.[0]?.title) return payload.embeds[0].title;
  if (payload.poll?.question?.text) return 'poll: ' + payload.poll.question.text;
  if (payload.components) return 'components message';
  return 'message';
}

async function schedFire(item) {
  const entry = profiles.get(item.profile);
  if (!entry) {
    item.status = 'failed';
    item.error = 'The webhook "' + item.profile + '" no longer exists.';
    schedWrite(item);
    return;
  }
  const files = (item.files || []).map(f => ({ ...f, buf: Buffer.from(f.data, 'base64') }));
  const query = { wait: 'true' };
  if (item.threadId) query.thread_id = item.threadId;
  if (item.payload.flags & FLAG.IS_COMPONENTS_V2) query.with_components = 'true';

  const r = await callDiscord(entry.url, { method: 'POST', body: item.payload, files, query });
  if (r.ok) {
    log('scheduler', 'sent', item.profile, item.id);
    logEvent('send', { profile: item.profile, thread: item.threadId || null, id: r.id || null,
                       summary: item.summary, payload: item.payload, scheduled: true,
                       repeat: item.repeat || undefined,
                       files: (item.files || []).map(f => ({ name: f.name, bytes: 0 })) });

    /* a repeating item lines itself up again instead of being consumed */
    const next = item.repeat ? nextOccurrence(item.at, item.repeat) : null;
    if (next && (!item.until || next <= item.until)) {
      item.at = next;
      item.status = 'pending';
      item.sentCount = (item.sentCount || 0) + 1;
      delete item.error;
      schedWrite(item);
      log('scheduler', 'requeued', item.profile, new Date(next).toISOString());
    } else {
      schedRemove(item.id);
    }
  } else {
    item.status = 'failed';
    item.error = r.error;
    schedWrite(item);
    log('scheduler', 'failed', item.profile, item.id);
    logEvent('send-failed', { profile: item.profile, summary: item.summary,
                              payload: item.payload, scheduled: true, error: r.error });
  }
}

async function schedTick() {
  if (!SCHEDULING) return;
  const now = Date.now();
  for (const item of schedLoad()) {
    if (item.status !== 'pending' || item.at > now) continue;
    if (now - item.at > SCHED_GRACE) {
      /* A repeating item skips whatever it missed and waits for the next one -
         marking a weekly digest permanently missed would silently end it. */
      if (item.repeat) {
        const next = advancePast(item.at, item.repeat, now);
        if (next && (!item.until || next <= item.until)) {
          item.at = next;
          schedWrite(item);
          log('scheduler', 'skipped', item.profile, new Date(next).toISOString());
          logEvent('scheduled-skipped', { profile: item.profile, summary: item.summary,
                                          next: new Date(next).toISOString() });
        } else {
          schedRemove(item.id);
        }
        continue;
      }
      item.status = 'missed';
      item.error = 'The server was not running when this was due.';
      schedWrite(item);
      log('scheduler', 'missed', item.profile, item.id);
      logEvent('scheduled-missed', { profile: item.profile, summary: item.summary,
                                     due: new Date(item.at).toISOString() });
      continue;
    }
    item.status = 'sending';
    schedWrite(item);
    await schedFire(item);
  }
}

function schedStart() {
  if (!SCHEDULING) return;
  schedTick().catch(() => {});
  schedTimer = setInterval(() => schedTick().catch(() => {}), 15_000);
  schedTimer.unref();
}

/* ---------------------------------------------------------------- endpoints */
function schedOff(res) {
  return send(res, 403, {
    error: 'Scheduling needs the server running from source. The packaged executable ' +
           'cannot schedule, because it only runs while the window is open.' });
}

/* Sent messages, read back out of the log. This is why the log keeps content:
   the page rebuilds its history from here, so it survives a cleared browser,
   a different browser, or messages sent by the scheduler while nobody watched. */
async function handleHistory(req, res, url) {
  if (!gate(req, res)) return;
  if (!LOG_ON) return send(res, 200, { ok: true, items: [], logging: false });

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);

  /* Scan wider than the limit: a delete or edit can sit many rows after the send
     it refers to, and dropping it would resurrect a deleted message here. */
  const rows = logRead(r => r.id && ['send', 'delete', 'edit', 'gone'].includes(r.kind), limit * 6);

  const gone = new Set(), edited = new Map();
  for (const r of rows) {                          /* newest first */
    /* 'delete' is one we removed; 'gone' is one that vanished at Discord and was
       noticed later. Both mean it should stop being listed. */
    if (r.kind === 'delete' || r.kind === 'gone') gone.add(r.id);
    /* first edit seen is the newest, so keep that one */
    else if (r.kind === 'edit' && !edited.has(r.id)) edited.set(r.id, r.summary);
  }

  const items = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.kind !== 'send' || gone.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    items.push({
      id: r.id, at: Date.parse(r.t) || Date.now(), profile: r.profile,
      threadId: r.thread || '',
      summary: edited.get(r.id) || r.summary || 'message',
      edited: edited.has(r.id),
      scheduled: !!r.scheduled, attachments: (r.files || []).length
    });
    if (items.length >= limit) break;
  }
  return send(res, 200, { ok: true, logging: true, items });
}

/* The page found a listed message no longer exists at Discord - somebody deleted
   it there rather than from here. Recorded so the history stops listing it; the
   original send stays in the log, since the point of the log is that nothing is
   forgotten. */
async function handleForget(req, res, ip) {
  if (!gate(req, res, { json: true })) return;

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const id = String(body.id || '').trim();
  if (!snowflake(id)) return send(res, 400, { error: 'Invalid message ID.' });

  logEvent('gone', { id, profile: String(body.profile || '') || undefined });
  log(ip, 'gone', id);
  return send(res, 200, { ok: true });
}

async function handleScheduleList(req, res) {
  if (!gate(req, res)) return;
  if (!SCHEDULING) return schedOff(res);
  return send(res, 200, { ok: true, items: schedLoad().map(schedPublic) });
}

async function handleScheduleCreate(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!SCHEDULING) return schedOff(res);
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;
    return send(res, e.status === 413 ? 413 : 400, { error: 'Request body too large.' });
  }

  const entry = profiles.get(String(body.profile || ''));
  if (!entry) return send(res, 400, { error: 'Unknown webhook profile.' });

  const at = Number(body.at);
  if (!Number.isFinite(at) || at < Date.now() - 60_000)
    return send(res, 400, { error: 'That time is in the past.' });
  if (at > Date.now() + 365 * 86400_000)
    return send(res, 400, { error: 'Scheduling more than a year ahead is not supported.' });

  const thread = String(body.threadId || '').trim();
  if (thread && !snowflake(thread)) return send(res, 400, { error: 'Invalid thread ID.' });

  const { payload, errs } = cleanPayload(body.payload);
  const files = cleanFiles(body.files, errs);
  if (errs.length) return send(res, 400, { error: errs.join(' ') });
  const attachErr = applyAttachments(payload, files);
  if (attachErr) return send(res, 400, { error: attachErr });

  if (schedLoad().length >= SCHED_MAX)
    return send(res, 429, { error: 'The schedule is full (' + SCHED_MAX + ' items).' });

  const repeat = REPEATS.includes(body.repeat) ? body.repeat : null;
  let until = null;
  if (repeat && body.until != null) {
    until = Number(body.until);
    if (!Number.isFinite(until) || until < at)
      return send(res, 400, { error: 'The end date is before the first send.' });
  }

  const item = {
    id: schedId(), at, profile: String(body.profile), threadId: thread,
    status: 'pending', createdAt: Date.now(), summary: schedSummarise(payload), payload,
    repeat, until, sentCount: 0,
    files: files.map(f => ({ name: f.name, type: f.type, data: f.buf.toString('base64') }))
  };
  try { schedWrite(item); }
  catch (e) { return send(res, 500, { error: 'Could not save the schedule: ' + e.message }); }

  log(ip, 'schedule', item.profile, new Date(at).toISOString());
  logEvent('scheduled', { profile: item.profile, id: item.id, summary: item.summary,
                          due: new Date(at).toISOString() });
  return send(res, 200, { ok: true, item: schedPublic(item), items: schedLoad().map(schedPublic) });
}

async function handleScheduleDelete(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!SCHEDULING) return schedOff(res);

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const id = String(body.id || '');
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) return send(res, 400, { error: 'Invalid id.' });
  if (!fs.existsSync(schedPath(id))) return send(res, 404, { error: 'No such scheduled message.' });

  schedRemove(id);
  log(ip, 'schedule', 'cancelled', id);
  return send(res, 200, { ok: true, items: schedLoad().map(schedPublic) });
}

/* Resolve {profile, messageId?} from a request body, or answer with the error. */
function resolve(res, body, { needMessage = false } = {}) {
  const entry = profiles.get(String(body.profile || ''));
  if (!entry) { send(res, 400, { error: 'Unknown webhook profile.' }); return null; }

  const thread = String(body.threadId || '').trim();
  if (thread && !snowflake(thread)) { send(res, 400, { error: 'Invalid thread ID.' }); return null; }

  let messageId = null;
  if (needMessage) {
    messageId = String(body.messageId || '').trim();
    if (!snowflake(messageId)) { send(res, 400, { error: 'Invalid message ID.' }); return null; }
  }
  return { entry, thread, messageId, query: thread ? { thread_id: thread } : {} };
}

/* Attach the validated uploads and check that every attachment:// reference in the
   payload actually points at one of them. Client-supplied `attachments` is ignored
   and rebuilt here, so a modified client cannot reference files it did not send. */
function applyAttachments(payload, files) {
  delete payload.attachments;
  const refs = attachRefs(payload);
  const names = new Set(files.map(f => f.name));

  for (const r of refs)
    if (!names.has(r)) return 'The message references attachment://' + r + ' but no such image was uploaded.';

  if (files.length) {
    const unused = files.filter(f => !refs.has(f.name));
    if (unused.length)
      return 'Uploaded image ' + unused[0].name + ' is not used anywhere in the message.';
    payload.attachments = files.map((f, i) => ({ id: i, filename: f.name }));
  }
  return null;
}

/* Only these keys are accepted when editing an existing message. */
function editablePart(p) {
  const o = {};
  if ('content' in p)    o.content = p.content;
  if ('embeds' in p)     o.embeds = p.embeds;
  if ('components' in p) o.components = p.components;
  if (p.allowed_mentions) o.allowed_mentions = p.allowed_mentions;
  const keep = (p.flags || 0) & (FLAG.SUPPRESS_EMBEDS | FLAG.IS_COMPONENTS_V2);
  if (keep) o.flags = keep;
  /* clearing everything is legal only if something else remains */
  if (!('content' in o) && !o.embeds && !o.components) o.content = '';
  return o;
}

/* ------------------------------------------------------------- templates
   A composed message saved under a name. These live on disk rather than in the
   browser so they survive cleared site data, and so every browser pointed at
   this server sees the same set. The file sits beside .env - next to the exe
   when packaged, next to server.js otherwise.

   The stored `data` is the page's own editor state, not a Discord payload, so
   it is kept verbatim rather than run through cleanPayload(). Nothing here
   reaches Discord without being sent back up through /api/send first, which
   sanitises it like any other message. Size and count are capped so an
   authenticated client cannot grow the file without bound. */
const TPL_FILE      = path.join(ROOT, 'templates.json');
const TPL_MAX       = 100;
const TPL_NAME_MAX  = 60;
const TPL_ONE_MAX   = 256 * 1024;
const TPL_FILE_MAX  = 2 * 1024 * 1024;

function tplLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
    return Array.isArray(j)
      ? j.filter(t => t && typeof t.name === 'string' && t.data && typeof t.data === 'object')
      : [];
  } catch { return []; }        /* missing, unreadable or corrupt - start empty */
}

function tplWrite(list) {
  const tmp = TPL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TPL_FILE);   /* rename is atomic - no half-written file */
}

async function handleTemplateList(req, res) {
  if (!gate(req, res)) return;
  return send(res, 200, { ok: true, items: tplLoad() });
}

async function handleTemplateSave(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;
    return send(res, e.status === 413 ? 413 : 400, { error: 'Request body too large.' });
  }

  const name = String(body.name || '').trim();
  if (!name || name.length > TPL_NAME_MAX)
    return send(res, 400, { error: 'A template name must be 1-' + TPL_NAME_MAX + ' characters.' });
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))
    return send(res, 400, { error: 'Missing template data.' });

  const data = body.data;
  if (JSON.stringify(data).length > TPL_ONE_MAX)
    return send(res, 400, { error: 'That template is too large (limit ' +
                                   (TPL_ONE_MAX / 1024) + ' KB).' });

  const list = tplLoad();
  const at = list.findIndex(t => t.name === name);
  if (at < 0 && list.length >= TPL_MAX)
    return send(res, 400, { error: 'No room for another template (limit ' + TPL_MAX + ').' });

  if (at < 0) list.push({ name, data, savedAt: Date.now() });
  else list[at] = { name, data, savedAt: Date.now() };
  list.sort((a, b) => a.name.localeCompare(b.name));

  if (JSON.stringify(list).length > TPL_FILE_MAX)
    return send(res, 400, { error: 'The template file is full (limit ' +
                                   (TPL_FILE_MAX / 1048576) + ' MB).' });

  try { tplWrite(list); }
  catch (e) { return send(res, 500, { error: 'Could not save: ' + e.message }); }

  log(ip, 'template', (at < 0 ? 'saved ' : 'replaced ') + name);
  logEvent('template-' + (at < 0 ? 'saved' : 'replaced'), { name });
  return send(res, 200, { ok: true, items: list });
}

async function handleTemplateDelete(req, res, ip) {
  if (!gate(req, res, { json: true })) return;

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;
    return send(res, e.status === 413 ? 413 : 400, { error: 'Request body too large.' });
  }

  const name = String(body.name || '').trim();
  const list = tplLoad();
  const kept = list.filter(t => t.name !== name);
  if (kept.length === list.length) return send(res, 404, { error: 'No template by that name.' });

  try { tplWrite(kept); }
  catch (e) { return send(res, 500, { error: 'Could not save: ' + e.message }); }

  log(ip, 'template', 'deleted ' + name);
  logEvent('template-deleted', { name });
  return send(res, 200, { ok: true, items: kept });
}

async function handleMessage(req, res, ip, action) {
  if (!gate(req, res, { json: true })) return;
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;
    return send(res, e.status === 413 ? 413 : 400, { error: 'Request body too large.' });
  }

  const r = resolve(res, body, { needMessage: true });
  if (!r) return;
  const base = r.entry.url + '/messages/' + r.messageId;
  const label = action + ' ' + body.profile;

  if (action === 'get')
    return forward(res, ip, label, base, { method: 'GET', query: r.query });

  if (action === 'delete') {
    const d = await callDiscord(base, { method: 'DELETE', query: r.query });
    log(ip, label, d.tag);
    logEvent(d.ok ? 'delete' : 'delete-failed',
             { profile: body.profile, id: r.messageId, error: d.ok ? undefined : d.error });
    return d.ok ? send(res, 200, { ok: true, id: null, data: null })
                : send(res, d.status, { error: d.error });
  }

  const { payload, errs } = cleanPayload(body.payload);
  const files = cleanFiles(body.files, errs);
  if (errs.length) return send(res, 400, { error: errs.join(' ') });
  const patch = editablePart(payload);
  const attachErr = applyAttachments(patch, files);
  if (attachErr) return send(res, 400, { error: attachErr });
  const query = { ...r.query };
  if (patch.flags & FLAG.IS_COMPONENTS_V2) query.with_components = 'true';
  const e = await callDiscord(base, { method: 'PATCH', body: patch, files, query });
  log(ip, label, e.tag);
  logEvent(e.ok ? 'edit' : 'edit-failed', {
    profile: body.profile, id: r.messageId, summary: schedSummarise(patch),
    payload: patch, files: logFiles(files), error: e.ok ? undefined : e.error });
  return e.ok ? send(res, 200, { ok: true, id: e.id, data: e.data })
              : send(res, e.status, { error: e.error });
}

/* ----------------------------------------------------- the webhook itself */
async function handleWebhookInfo(req, res, ip, url) {
  if (!gate(req, res)) return;
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });
  const name = url.searchParams.get('profile') || '';
  const entry = profiles.get(name);
  if (!entry) return send(res, 400, { error: 'Unknown webhook profile.' });
  return forward(res, ip, 'info ' + name, entry.url, { method: 'GET' });
}

async function handleWebhookRename(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const r = resolve(res, body);
  if (!r) return;
  const name = str(body.name).trim();
  if (name.length < 1 || name.length > 80)
    return send(res, 400, { error: 'Webhook name must be 1–80 characters.' });
  if (/discord/i.test(name))
    return send(res, 400, { error: 'Webhook name cannot contain "discord".' });

  return forward(res, ip, 'rename ' + body.profile, r.entry.url, { method: 'PATCH', body: { name } });
}

/* The webhook's own picture. Discord wants the image inline as a base64 data
   URI rather than multipart, and accepts null to clear it. Same magic-byte
   check as message uploads - a renamed .php must not get through here either. */
const AVATAR_MAX = 8 * 1024 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

async function handleWebhookAvatar(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (e) {
    if (req.socket.destroyed || res.writableEnded) return;
    return send(res, e.status === 413 ? 413 : 400, { error: 'Request body too large.' });
  }

  const r = resolve(res, body);
  if (!r) return;

  if (body.remove) {
    logEvent('webhook-avatar', { profile: body.profile, removed: true });
    return forward(res, ip, 'avatar ' + body.profile, r.entry.url,
                   { method: 'PATCH', body: { avatar: null } });
  }

  const f = body.file;
  if (!f || typeof f !== 'object') return send(res, 400, { error: 'No image supplied.' });
  const type = str(f.type).toLowerCase();
  if (!AVATAR_TYPES.includes(type))
    return send(res, 400, { error: 'A webhook picture must be a PNG, JPEG or GIF.' });

  let buf;
  try { buf = Buffer.from(str(f.data), 'base64'); }
  catch { return send(res, 400, { error: 'Could not decode the image.' }); }
  if (!buf.length) return send(res, 400, { error: 'That image is empty.' });
  if (buf.length > AVATAR_MAX)
    return send(res, 400, { error: 'The picture is larger than ' + (AVATAR_MAX / 1048576) + ' MB.' });
  if (!IMG_SIG[type].some(sig => sig.every((b, i) => buf[i] === b)))
    return send(res, 400, { error: 'That file is not really a ' + type.split('/')[1].toUpperCase() + '.' });

  logEvent('webhook-avatar', { profile: body.profile, bytes: buf.length, type });
  return forward(res, ip, 'avatar ' + body.profile, r.entry.url, {
    method: 'PATCH',
    body: { avatar: 'data:' + type + ';base64,' + buf.toString('base64') }
  });
}

/* Deletes the webhook at Discord *and* drops it from .env - irreversible. */
async function handleWebhookRevoke(req, res, ip) {
  if (!gate(req, res, { json: true })) return;
  if (!MANAGE) return send(res, 403, { error: 'Revoking webhooks is disabled on this server.' });
  if (!rateOk(ip)) return send(res, 429, { error: 'Rate limit reached - slow down.' }, { 'Retry-After': '30' });

  let body;
  try { body = JSON.parse(await readBody(req, 8 * 1024)); }
  catch { if (req.socket.destroyed) return; return send(res, 400, { error: 'Could not read the request body.' }); }

  const name = String(body.profile || '').trim().toLowerCase();
  const entry = profiles.get(name);
  if (!entry) return send(res, 400, { error: 'Unknown webhook profile.' });
  if (entry.fromProcessEnv) return send(res, 409, {
    error: '"' + name + '" is set by an environment variable; remove it there instead.' });

  let up;
  try { up = await fetch(entry.url, { method: 'DELETE', signal: AbortSignal.timeout(15_000) }); }
  catch (e) { return send(res, 502, { error: 'Could not reach Discord: ' + e.message }); }

  /* 404/401 means it is already gone upstream - still worth clearing locally */
  if (!up.ok && ![401, 404].includes(up.status)) {
    let msg = up.status + ' ' + up.statusText;
    try { const j = await up.json(); if (j.message) msg += ' - ' + j.message; } catch {}
    return send(res, 502, { error: msg });
  }
  try { writeEnvKey(entry.key, null); }
  catch (e) { return send(res, 500, { error: 'Deleted at Discord but could not update .env: ' + e.message }); }

  profiles.delete(name);
  log(ip, 'revoke', name, up.ok ? 'ok' : 'already-gone');
  logEvent('webhook-revoked', { profile: name, alreadyGone: !up.ok });
  return send(res, 200, { ok: true, alreadyGone: !up.ok, profiles: profileList() });
}

function servePage(req, res) {
  let html;
  try { html = readAsset('index.html', PAGE); }
  catch { return send(res, 500, { error: 'index.html could not be read.' }); }

  /* nonce the one inline script so the CSP can forbid every other script */
  const nonce = crypto.randomBytes(16).toString('base64');
  html = html.replace('<script>', '<script nonce="' + nonce + '">');

  const csp = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "'",
    "style-src 'unsafe-inline'",          /* the UI sets style="" attributes as it renders */
    "img-src 'self' https: data: blob:",     /* blob: for local upload previews */
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');

  const buf = Buffer.from(html);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  });
  res.end(buf);
}

/* A marker so the shape of a run reads at a glance: green for something made,
   red for something taken away, yellow when it did not work, and a dim dot for
   everything else. Classified from the line itself rather than passed in at
   every call site, so a new log line gets a sensible marker for free. */
function marker(text) {
  if (/\b(fail(ed)?|error|rate-limited|invalid|denied|missed|already-gone|not-found)\b/i.test(text))
    return CLR.warn + '!' + CLR.off;
  if (/^(delete|revoke)\b|\b(removed|deleted|cancelled|revoked)\b/i.test(text))
    return CLR.err + '-' + CLR.off;
  if (/^(send|schedule)\b|\b(added|saved|created|replaced|updated|generated)\b/i.test(text))
    return CLR.ok + '+' + CLR.off;
  return CLR.dim + '·' + CLR.off;
}

function log(ip, ...rest) {
  /* never logs webhook URLs or the token */
  const text = rest.join(' ');
  console.log('  ' + marker(text) + ' ' + CLR.dim + new Date().toISOString().slice(11, 19)
              + '  ' + ip + CLR.off + '  ' + text);
}

/* -------------------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html'))
      return servePage(req, res);

    if (req.method === 'GET' && route === '/api/config') {
      if (!gate(req, res)) return;
      checkUpdate();                   /* refresh in the background if stale */
      return send(res, 200, {
        profiles: profileList(),
        canManage: MANAGE,
        /* the packaged exe is a local app you close; from source it is a server
           that keeps running. The page labels itself accordingly. */
        mode: IS_SEA ? 'local' : 'server',
        logging: LOG_ON,
        scheduling: SCHEDULING,
        templates: true,                 /* stored on disk, so both modes have them */
        version: VERSION,
        update: updateInfo,
        uploadMaxMb: UPLOAD_MAX / 1048576,
        locked: [...profiles].filter(([, v]) => v.fromProcessEnv).map(([k]) => k),
        blockMentions: BLOCK_PINGS
      });
    }

    if (req.method === 'POST' && route === '/api/send')    return handleSend(req, res, ip);
    if (req.method === 'POST' && route === '/api/profiles') return handleAddProfile(req, res, ip);
    if (req.method === 'POST' && route === '/api/profiles/delete') return handleDeleteProfile(req, res, ip);

    if (req.method === 'POST' && route === '/api/message/edit')   return handleMessage(req, res, ip, 'edit');
    if (req.method === 'POST' && route === '/api/message/delete') return handleMessage(req, res, ip, 'delete');
    if (req.method === 'POST' && route === '/api/message/get')    return handleMessage(req, res, ip, 'get');

    if (req.method === 'GET'  && route === '/api/history')         return handleHistory(req, res, url);
    if (req.method === 'POST' && route === '/api/history/forget')  return handleForget(req, res, ip);
    if (req.method === 'GET'  && route === '/api/schedule')        return handleScheduleList(req, res);
    if (req.method === 'POST' && route === '/api/schedule')        return handleScheduleCreate(req, res, ip);
    if (req.method === 'POST' && route === '/api/schedule/delete') return handleScheduleDelete(req, res, ip);

    if (req.method === 'GET'  && route === '/api/templates')        return handleTemplateList(req, res);
    if (req.method === 'POST' && route === '/api/templates')        return handleTemplateSave(req, res, ip);
    if (req.method === 'POST' && route === '/api/templates/delete') return handleTemplateDelete(req, res, ip);

    if (req.method === 'GET'  && route === '/api/webhook/info')   return handleWebhookInfo(req, res, ip, url);
    if (req.method === 'POST' && route === '/api/webhook/rename') return handleWebhookRename(req, res, ip);
    if (req.method === 'POST' && route === '/api/webhook/avatar') return handleWebhookAvatar(req, res, ip);
    if (req.method === 'POST' && route === '/api/webhook/revoke') return handleWebhookRevoke(req, res, ip);

    /* Only the routes above exist - there is no static file serving at all,
       so there is no path-traversal surface. */
    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    log(ip, 'error', e.message);
    if (!res.headersSent) send(res, 500, { error: 'Internal error.' });
  }
});

server.listen(PORT, HOST, () => {
  const shown = isLoopback(HOST) ? 'localhost' : HOST;
  const base  = 'http://' + shown + ':' + PORT;
  const url   = base + '/#token=' + TOKEN;

  /* Three blocks, divided: how to get in, what it is set up to do, and where it
     keeps its files. Each block aligns its own labels; the box takes its width
     from the widest line in any of them. */
  const access = [
    ['ready', url],
    /* on its own line as well as in the link, because the unlock prompt asks for
       the token by itself and picking it out of a URL is a nuisance */
    ['token', TOKEN]
  ];

  const setup = [
    ['hooks', profiles.size
      ? profileList().join(', ')
      : (MANAGE ? 'none yet - add one from the page'
                : 'none yet - add WEBHOOK_<name>=<url> lines to .env')],
    ['limit', RATE_PER_MIN + ' sends/min per client']
  ];
  if (BLOCK_PINGS) setup.push(['pings', 'suppressed (BLOCK_MENTIONS=1)']);
  if (SCHEDULING) {
    const q = schedLoad().filter(i => i.status === 'pending').length;
    setup.push(['queue', q ? q + ' scheduled message(s) waiting' : 'on - sends without a browser']);
  }

  /* Where things land. Shown whether or not the file exists yet - knowing where
     it will be written is the point. They all sit in one folder, so the folder
     is named once and the rest are relative to it; anything moved elsewhere
     (LOG_FILE can be) falls back to its full path. */
  const rel = p => p.startsWith(ROOT + path.sep) ? p.slice(ROOT.length + 1) : p;
  const files = [
    ['folder', ROOT],
    ['config', rel(ENVFILE)],
    ['templates', rel(TPL_FILE)]
  ];
  if (LOG_ON)     files.push(['log', rel(LOG_FILE)]);
  if (SCHEDULING) files.push(['schedule', rel(SCHED_DIR) + path.sep]);

  const groups = [access, setup, files];

  const title = 'Discord Webhook Poster';
  const ver   = 'v' + VERSION;
  const note  = 'The link and the token are the keys to your channel - keep them private.';
  const warn  = EXPOSED ? 'exposed on ' + HOST + ' - make sure TLS terminates in front of this' : '';

  const widths = groups.map(g => Math.max(...g.map(r => r[0].length)));
  const MAXW = 92;                     /* a deep install path should not stretch the box */
  const inner = Math.min(MAXW, Math.max(
    title.length + ver.length + 3,
    warn ? warn.length + 2 : 0,
    ...groups.flatMap((g, i) => g.map(r => widths[i] + 2 + r[1].length))
  ));
  /* keep the tail of anything too long: the end of a path is the useful half */
  groups.forEach((g, i) => {
    const room = inner - widths[i] - 2;
    for (const r of g) if (r[1].length > room) r[1] = '…' + r[1].slice(-(room - 1));
  });
  const line = '─'.repeat(inner + 2);

  const out = [];
  out.push('');
  out.push(CLR.dim + '  ╭' + line + '╮' + CLR.off);
  out.push(CLR.dim + '  │ ' + CLR.off + CLR.bold + title + CLR.off
           + ' '.repeat(inner - title.length - ver.length) + CLR.dim + ver
           + ' │' + CLR.off);
  groups.forEach((g, i) => {
    out.push(CLR.dim + '  ├' + line + '┤' + CLR.off);
    for (const [k, v] of g)
      out.push(CLR.dim + '  │ ' + CLR.off + CLR.dim + k.padEnd(widths[i]) + CLR.off + '  '
               + (g === access ? CLR.link + v + CLR.off : v)
               + ' '.repeat(inner - widths[i] - 2 - v.length) + CLR.dim + ' │' + CLR.off);
  });
  if (warn) {
    out.push(CLR.dim + '  ├' + line + '┤' + CLR.off);
    out.push(CLR.dim + '  │ ' + CLR.off + CLR.warn + '! ' + warn + CLR.off
             + ' '.repeat(inner - warn.length - 2) + CLR.dim + ' │' + CLR.off);
  }
  out.push(CLR.dim + '  ╰' + line + '╯' + CLR.off);
  out.push('');
  out.push('  ' + CLR.dim + note + CLR.off);
  out.push('');
  console.log(out.join('\n'));

  schedStart();
  /* fire and forget - never delays startup, never fails loudly */
  checkUpdate().then(offerUpdate).catch(() => {});

  if (OPEN_BROWSER && !EXPOSED) {
    const url = base + '/#token=' + TOKEN;
    const cmd = process.platform === 'win32' ? 'start ""'
              : process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('node:child_process').exec(cmd + ' "' + url + '"', () => {});
  }
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => { console.log('\n  stopping…'); server.close(() => process.exit(0)); });
