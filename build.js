#!/usr/bin/env node
'use strict';
/* =============================================================================
   Build a single-file executable using Node's built-in SEA support.

     node build.js   ->   DiscordWebhookPoster.exe (project root)

   Node compiles server.js plus its assets into a blob, we copy the running node
   binary, and postject injects the blob into that copy. The result needs no Node
   installed. Most of the ~67 MB is the Node runtime itself.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT   = __dirname;
const BUILD  = path.join(ROOT, 'build');
const CONFIG = path.join(ROOT, 'sea-config.json');
const BLOB   = path.join(BUILD, 'sea-prep.blob');
const WIN    = process.platform === 'win32';
const MAC    = process.platform === 'darwin';
const NAME   = 'DiscordWebhookPoster' + (WIN ? '.exe' : '');
const ICON   = path.join(ROOT, 'icon.ico');
/* the same version the app reports, so the file properties cannot disagree
   with what the update checker compares against */
const VERSION = require(path.join(ROOT, 'package.json')).version;

/* Build and verify inside build/, then publish to the project root only once it
   works. Verifying in place would run the exe next to the real .env; staging it
   keeps the generated one in the throwaway folder instead. */
const STAGE  = path.join(BUILD, NAME);
const EXE    = path.join(ROOT, NAME);

/* Node's documented sentinel; postject looks for it inside the binary. */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = m => console.log('\n> ' + m);
const mb   = n => (n / 1048576).toFixed(1) + ' MB';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/* Node refuses to spawn .cmd/.bat directly (CVE-2024-27980), so npx.cmd is out.
   Drive npm's own npx-cli.js with the node binary instead - same result, no shell. */
function npx(args, opts = {}) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], opts);
  return run(WIN ? 'npx.cmd' : 'npx', args, { ...opts, shell: true });
}

/* Same trick for npm itself. */
function npm(args, opts = {}) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], opts);
  return run(WIN ? 'npm.cmd' : 'npm', args, { ...opts, shell: true });
}

/* rcedit is a library rather than a command, so npx has nothing to run. Install
   it into the staging folder - which is deleted at the end of the build - and
   call the Windows binary it ships. Pinned to 4.x because 5 wants Node 22. */
function rcedit(args) {
  fs.writeFileSync(path.join(BUILD, 'package.json'),
                   '{"name":"build-tools","version":"1.0.0","private":true}\n');
  npm(['install', '--no-save', '--no-audit', '--no-fund', '--silent',
       '--prefix', BUILD, 'rcedit@4'], { stdio: 'ignore' });
  const exe = path.join(BUILD, 'node_modules', 'rcedit', 'bin',
                        process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe');
  if (!fs.existsSync(exe)) throw new Error('rcedit did not install');
  run(exe, args, { stdio: 'ignore' });
}

/* ------------------------------------------------------------ prerequisites */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error('\n  Node 20.12+ is required to build (assets support). This is ' +
                process.versions.node + '.\n');
  process.exit(1);
}
for (const f of ['server.js', 'index.html', 'package.json', 'sea-config.json'])
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error('\n  Missing ' + f + ' - run this from the project directory.\n');
    process.exit(1);
  }

/* index.html carries its own copy of the version for the case where it is opened
   with no server to ask. Nothing keeps the two in step by itself, and a stale
   one makes the page announce an update that is already installed - so refuse to
   build rather than ship the mismatch. */
const pageVersion = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
                       .match(/const APP_VERSION = '([^']+)'/) || [])[1];
if (pageVersion !== VERSION) {
  console.error('\n  Version mismatch:');
  console.error('    package.json  ' + VERSION);
  console.error('    index.html    ' + (pageVersion || 'not found (APP_VERSION missing)'));
  console.error('\n  Set APP_VERSION in index.html to ' + VERSION + ' and build again.\n');
  process.exit(1);
}

console.log('\n  Building a single-file executable');
console.log('  ' + '─'.repeat(52));
console.log('  node    ' + process.versions.node + ' (' + process.platform + '/' + process.arch + ')');

/* ------------------------------------------------------------------- blob */
step('Compiling server.js + assets into a SEA blob');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
run(process.execPath, ['--experimental-sea-config', CONFIG]);
if (!fs.existsSync(BLOB)) {
  console.error('\n  The blob was not produced. Check sea-config.json.\n');
  process.exit(1);
}
console.log('  blob    ' + mb(fs.statSync(BLOB).size));

/* --------------------------------------------------------- copy the binary */
step('Copying the Node binary');
fs.copyFileSync(process.execPath, STAGE);
console.log('  base    ' + mb(fs.statSync(STAGE).size));

/* Windows signs node.exe; injecting invalidates that signature, so strip it if
   the SDK is around. Purely cosmetic - the build works either way. */
if (WIN) {
  try {
    run('signtool', ['remove', '/s', STAGE], { stdio: 'ignore' });
    console.log('  sig     removed the inherited Authenticode signature');
  } catch {
    console.log('  sig     signtool not available; the copied signature stays invalid (harmless)');
  }
}

/* macOS is stricter than cosmetic: an Apple-silicon binary with a broken
   signature will not run at all, so the inherited one has to come off before
   injection and an ad-hoc one go on afterwards. Ad-hoc is not notarisation -
   Gatekeeper will still warn on download - but the file at least starts. */
if (MAC) {
  try {
    run('codesign', ['--remove-signature', STAGE], { stdio: 'ignore' });
    console.log('  sig     removed the inherited signature');
  } catch {
    console.log('  sig     codesign not available; continuing');
  }
}

/* -------------------------------------------------------- icon and details
   Without this the exe wears the Node.js logo and calls itself "Node.js
   JavaScript Runtime" in its properties and in the SmartScreen dialog, which is
   what most people read to decide whether to trust it. Done before injection:
   rcedit rewrites the resource section, and doing that after the blob went in
   risks disturbing it. */
if (WIN) {
  step('Setting the icon and version details');
  const details = [
    '--set-version-string', 'ProductName', 'Discord Webhook Poster',
    '--set-version-string', 'FileDescription', 'Discord Webhook Poster',
    '--set-version-string', 'CompanyName', 'icelogw',
    '--set-version-string', 'LegalCopyright', '(c) 2026 icelogw. Personal use only.',
    '--set-version-string', 'OriginalFilename', NAME,
    '--set-file-version', VERSION,
    '--set-product-version', VERSION
  ];
  if (fs.existsSync(ICON)) details.unshift('--set-icon', ICON);
  try {
    rcedit([STAGE, ...details]);
    console.log('  icon    ' + (fs.existsSync(ICON) ? path.basename(ICON) : 'none found, kept the Node logo'));
    console.log('  details Discord Webhook Poster v' + VERSION);
  } catch (e) {
    /* not fatal: an exe with the wrong icon still works */
    console.log('  icon    rcedit failed, keeping the Node.js icon and strings');
  }
}

/* ---------------------------------------------------------------- inject */
step('Injecting the blob with postject');
const args = [STAGE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE];
if (MAC) args.push('--macho-segment-name', 'NODE_SEA');
npx(['--yes', 'postject', ...args]);

/* Re-sign after injection, or Apple silicon refuses to execute it at all. */
if (MAC) {
  try {
    run('codesign', ['--sign', '-', STAGE], { stdio: 'ignore' });
    console.log('  sig     signed ad-hoc so it will run locally');
  } catch {
    console.log('  sig     could not re-sign; the binary may not start on Apple silicon');
  }
}

/* ----------------------------------------------------------------- verify
   Actually run the thing: boot it on a spare port and fetch the page, which
   proves the bundled index.html asset is readable from inside the binary. */
step('Verifying - booting the exe and requesting the page');

const PORT = 39000 + (process.pid % 900);
const TOKEN = 'build-verify-token';

(async () => {
  const child = spawn(STAGE, [], {
    cwd: BUILD,
    env: { ...process.env, PORT: String(PORT), OPEN: '0', AUTH_TOKEN: TOKEN,
           HOST: '127.0.0.1', UPDATE_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  let html = null, cfg = null;
  for (let i = 0; i < 40 && html === null; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/');
      if (res.ok) {
        html = await res.text();
        const c = await fetch('http://127.0.0.1:' + PORT + '/api/config',
                              { headers: { Authorization: 'Bearer ' + TOKEN } });
        cfg = c.ok ? await c.json() : null;
      }
    } catch { /* not listening yet */ }
  }
  child.kill();
  /* the run may have created a .env next to the exe - don't ship a stray token */
  try { fs.rmSync(path.join(BUILD, '.env'), { force: true }); } catch {}

  const servedPage = !!html && html.includes('Discord Webhook Poster') && html.includes('<script');
  const apiWorks   = !!cfg && Array.isArray(cfg.profiles);
  const size = fs.statSync(STAGE).size;

  console.log('  page    ' + (servedPage ? 'served from the embedded asset (' +
                              Math.round(html.length / 1024) + ' KB)' : 'FAILED to serve'));
  console.log('  api     ' + (apiWorks ? 'responding and authenticating' : 'FAILED'));
  console.log('  version ' + (cfg && cfg.version ? 'v' + cfg.version + ' read from the embedded package.json'
                                                 : 'not reported'));
  if (!servedPage || !apiWorks) {
    console.log('\n  exe output:\n' + log.split('\n').map(l => '    ' + l).join('\n'));
    console.log('\n  Verification failed - the previous exe was left in place.\n');
    process.exit(1);
  }

  /* only now replace the published copy */
  step('Publishing');
  try {
    fs.copyFileSync(STAGE, EXE);
  } catch (e) {
    /* Windows will not let a running exe be overwritten, and antivirus can hold
       a freshly written one for a moment. Say which it is instead of leaking a
       raw copyfile error. */
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
      console.error('\n  Could not replace ' + NAME + ' - it is in use.');
      console.error('  Close the running ' + NAME + ' (or wait for antivirus to finish) and');
      console.error('  run the build again. The new build is ready at:');
      console.error('    ' + STAGE + '\n');
      process.exit(1);
    }
    throw e;
  }
  fs.rmSync(BUILD, { recursive: true, force: true });

  console.log('\n  ' + '─'.repeat(52));
  console.log('  built   ' + EXE);
  console.log('  size    ' + mb(size));
  console.log('  ' + '─'.repeat(52) + '\n');
  process.exit(0);
})();
