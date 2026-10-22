'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const update = require('../electron/app-update.js');

const packaged = { packaged: true, headless: false, platform: 'darwin', appImage: false, adHocSigned: false, hasUpdateConfig: true };

test('availability: only a packaged, properly signed build with a feed updates itself', () => {
  assert.deepStrictEqual(update.availability(packaged), { ok: true, reason: '' });
  assert.strictEqual(update.availability({ ...packaged, packaged: false }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, headless: true }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, hasUpdateConfig: false }).ok, false);
  // A fork's ad hoc build: Squirrel.Mac would refuse every update.
  assert.match(update.availability({ ...packaged, adHocSigned: true }).reason, /Developer ID/);
  assert.strictEqual(update.availability({ ...packaged, platform: 'win32', adHocSigned: true }).ok, true);
  assert.strictEqual(update.availability({ ...packaged, platform: 'linux' }).ok, false);
  assert.strictEqual(update.availability({ ...packaged, platform: 'linux', appImage: true }).ok, true);
});

test('quitPlan: an ordinary quit installs only with the setting on', () => {
  // Setting off (the default): only Restart to install installs.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: false, relaunch: false }), 'exit');
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: false, relaunch: true }), 'exit');
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: true, installOnQuit: false, relaunch: false }), 'install-relaunch');
  // Setting on.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: true, relaunch: false }), 'install');
  // A launch during the quit: the installer starts the new version.
  assert.strictEqual(update.quitPlan({ ready: true, restartRequested: false, installOnQuit: true, relaunch: true }), 'install-relaunch');
  // Nothing downloaded: nothing to do either way.
  for (const installOnQuit of [false, true]) {
    for (const restartRequested of [false, true]) {
      assert.strictEqual(update.quitPlan({ ready: false, restartRequested, installOnQuit, relaunch: false }), 'exit');
    }
  }
});

test('the library\'s own install-on-quit flag is never set on macOS', () => {
  assert.strictEqual(update.libraryInstallOnQuit('darwin', true), false);
  assert.strictEqual(update.libraryInstallOnQuit('darwin', false), false);
  assert.strictEqual(update.libraryInstallOnQuit('win32', true), true);
  assert.strictEqual(update.libraryInstallOnQuit('win32', false), false);
  assert.strictEqual(update.libraryInstallOnQuit('linux', true), true);
});

// electron-updater, standing in: an emitter recording what was asked of it.
function fakeLibrary() {
  const lib = new EventEmitter();
  lib.calls = [];
  lib.checkForUpdates = async () => { lib.calls.push(['check']); };
  lib.install = (silent, run) => { lib.calls.push(['install', silent, run]); return true; };
  lib.quitAndInstall = (silent, run) => { lib.calls.push(['quitAndInstall', silent, run]); };
  return lib;
}

function fakeNative() {
  const n = new EventEmitter();
  n.checks = 0;
  n.checkForUpdates = () => { n.checks++; setImmediate(() => n.emit('update-downloaded')); };
  return n;
}

// `record` seeds what the last run wrote down about an install it attempted
// (#632); the fake tracks what this run writes and clears.
function fakeRecord(seed = null) {
  return { seed, saved: null, cleared: false,
    read() { return this.seed; },
    write(a) { this.saved = a; },
    clear() { this.cleared = true; } };
}

function make({ platform = 'win32', installOnQuit = false, auto = true, record = null,
                version = '1.6.2', execPath = 'D:\\Games\\Ragnarok Offline\\Ragnarok Offline.exe' } = {}) {
  const prefs = { auto, installOnQuit };
  const lib = fakeLibrary();
  const native = fakeNative();
  const logs = [];
  const store = fakeRecord(record);
  const timers = { setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {} };
  const u = update.createAppUpdater({
    app: { getVersion: () => version },
    platform,
    execPath,
    log: m => logs.push(String(m)),
    preferences: () => ({ ...prefs }),
    availability: { ok: true, reason: '' },
    load: () => lib,
    nativeUpdater: () => native,
    installRecord: store,
    timers,
  });
  return { u, lib, native, prefs, record: store, logs };
}

async function downloaded(t, version = '1.6.3') {
  await t.u.check();
  t.lib.emit('update-available', { version });
  t.lib.emit('download-progress', { percent: 42.7 });
  assert.strictEqual(t.u.status().percent, 42);
  assert.strictEqual(t.u.status().canInstall, false);
  t.lib.emit('update-downloaded', { version });
}

test('a downloaded update waits; an ordinary quit with the setting off installs nothing', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const t = make({ platform, installOnQuit: false });
    await downloaded(t);
    assert.strictEqual(t.u.status().ready, '1.6.3');
    assert.strictEqual(t.u.status().canInstall, true);
    assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
    assert.strictEqual(await t.u.finishQuit({ restartRequested: false, relaunch: false }), 'none');
    assert.deepStrictEqual(t.lib.calls, [['check']], platform);
    assert.strictEqual(t.native.checks, 0, `${platform}: nothing handed to Squirrel.Mac`);
  }
});

test('Restart to install: silent install, then the new version starts', async () => {
  const t = make({ platform: 'win32' });
  await downloaded(t);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: true, relaunch: false }), 'handed-off');
  assert.deepStrictEqual(t.lib.calls.at(-1), ['quitAndInstall', true, true]);
});

test('the setting on: an ordinary quit installs, without starting the app again', async () => {
  const win = make({ platform: 'win32', installOnQuit: true });
  await downloaded(win);
  assert.strictEqual(win.lib.autoInstallOnAppQuit, true);
  assert.strictEqual(await win.u.finishQuit({ restartRequested: false, relaunch: false }), 'installed');
  assert.deepStrictEqual(win.lib.calls.at(-1), ['install', true, false]);

  // macOS: staged with Squirrel.Mac at quit, and only then.
  const mac = make({ platform: 'darwin', installOnQuit: true });
  await downloaded(mac);
  assert.strictEqual(mac.lib.autoInstallOnAppQuit, false);
  assert.strictEqual(mac.native.checks, 0);
  assert.strictEqual(await mac.u.finishQuit({ restartRequested: false, relaunch: false }), 'installed');
  assert.strictEqual(mac.native.checks, 1);
  assert.deepStrictEqual(mac.lib.calls, [['check']]);
});

test('turning the setting on or off applies at once', async () => {
  const t = make({ platform: 'win32', installOnQuit: false });
  await downloaded(t);
  assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
  t.prefs.installOnQuit = true;
  t.u.preferencesChanged();
  assert.strictEqual(t.lib.autoInstallOnAppQuit, true);
  t.prefs.installOnQuit = false;
  t.u.preferencesChanged();
  assert.strictEqual(t.lib.autoInstallOnAppQuit, false);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: false, relaunch: false }), 'none');
});

test('a newer release replaces the waiting one', async () => {
  const t = make();
  await downloaded(t, '1.6.3');
  t.lib.emit('update-available', { version: '1.6.4' });
  // While it downloads there is nothing whole to install.
  assert.strictEqual(t.u.status().canInstall, false);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: true, relaunch: false }), 'none');
  t.lib.emit('update-downloaded', { version: '1.6.4' });
  assert.strictEqual(t.u.status().ready, '1.6.4');
  assert.strictEqual(t.u.status().canInstall, true);
});

test('errors are reported quietly, in a short line', async () => {
  const t = make();
  t.lib.checkForUpdates = async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };
  const s = await t.u.check();
  assert.strictEqual(s.phase, 'error');
  assert.match(s.error, /offline/);
  assert.match(update.shortError(new Error('Cannot find latest-mac.yml ... ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), /no update files/);
});

test('disabled: no checks, nothing installed', async () => {
  const lib = fakeLibrary();
  const u = update.createAppUpdater({
    app: { getVersion: () => '1.6.2' }, log: () => {}, preferences: () => ({ auto: true, installOnQuit: true }),
    availability: { ok: false, reason: 'running from source' }, load: () => lib, nativeUpdater: () => null,
  });
  u.start();
  assert.strictEqual((await u.check()).phase, 'disabled');
  assert.strictEqual(await u.finishQuit({ restartRequested: true, relaunch: false }), 'none');
  assert.deepStrictEqual(lib.calls, []);
});

// What the macOS half rests on: electron-updater hands a download to
// Squirrel.Mac (which then installs it on any exit) only when its
// autoInstallOnAppQuit is set, or from quitAndInstall. A version of the
// library that stages unconditionally would make an ordinary quit install.
// Skipped where the root dependencies are not installed (test.yml's shell
// suite runs without them); `npm install` and it runs.
const macUpdater = path.join(__dirname, '..', 'node_modules', 'electron-updater', 'out', 'MacUpdater.js');
test('electron-updater stages with Squirrel.Mac only when told to', { skip: !fs.existsSync(macUpdater) && 'electron-updater is not installed' }, () => {
  const src = fs.readFileSync(macUpdater, 'utf8');
  const calls = [...src.matchAll(/this\.nativeUpdater\.checkForUpdates\(\)/g)].map(m => m.index);
  assert.strictEqual(calls.length, 2, 'two places hand the update to Squirrel.Mac');
  const before = i => src.slice(Math.max(0, i - 900), i);
  // In the download path, behind `if (this.autoInstallOnAppQuit)`.
  assert.match(before(calls[0]), /if \(this\.autoInstallOnAppQuit\) \{[^}]*$/);
  // In quitAndInstall, only when the flag was off (so the download path did not).
  assert.match(before(calls[1]), /quitAndInstall\(\) \{[\s\S]*if \(!this\.autoInstallOnAppQuit\) \{[^}]*$/);
});

test('Windows: the update installs over the folder this copy runs from, even on another drive (#632)', async () => {
  const t = make({ platform: 'win32' });
  await downloaded(t);
  assert.strictEqual(t.lib.installDirectory, 'D:\\Games\\Ragnarok Offline');
  assert.strictEqual(update.windowsInstallDirectory('C:\\Users\\p\\AppData\\Local\\Programs\\ragnarokoffline\\Ragnarok Offline.exe'),
    'C:\\Users\\p\\AppData\\Local\\Programs\\ragnarokoffline');
  assert.strictEqual(update.windowsInstallDirectory(''), null);
  for (const platform of ['darwin', 'linux']) {
    const other = make({ platform });
    await downloaded(other);
    assert.strictEqual(other.lib.installDirectory, undefined, platform);
  }
});

// ---------------------------------------------------------------------------
// #632: an update that installs into another folder
//
// The 1.6.7 fix set installDirectory and its test asserted the property was
// set on the fake library -- which proves we *ask* the installer for a folder,
// not that it obeys. It does not, reliably: NSIS works its own destination out
// (initMultiUser in electron-builder's assistedInstaller.nsh resolves $INSTDIR
// from the registry before /D is consulted), so the update can succeed into
// the default folder and leave the running copy untouched. These cover what
// the app does about that, which is the part we control.
// ---------------------------------------------------------------------------

test('a version older than the one installed means the update went elsewhere', () => {
  const attempt = { version: '1.6.8', directory: 'D:\\Games\\Ragnarok Offline' };
  assert.deepStrictEqual(update.installLanded({ attempt, version: '1.6.6' }),
    { expected: '1.6.8', running: '1.6.6', directory: 'D:\\Games\\Ragnarok Offline' });
  // Running what we installed: it landed.
  assert.strictEqual(update.installLanded({ attempt, version: '1.6.8' }), null);
  // Newer still, from a hand-installed release: no longer a problem.
  assert.strictEqual(update.installLanded({ attempt, version: '1.7.0' }), null);
  // Nothing recorded, or a record without a version: nothing to say.
  for (const a of [null, undefined, {}, { directory: 'D:\\x' }]) {
    assert.strictEqual(update.installLanded({ attempt: a, version: '1.6.6' }), null, String(a));
  }
});

// A version shape we do not recognise must report no problem rather than a
// false one -- accusing a release of failing is worse than saying nothing.
test('an unreadable version is never called a failure', () => {
  for (const [running, installed] of [['', '1.6.8'], ['1.6.6', ''], ['x', '1.6.8'], ['1.6.6', '1.6.8-beta']]) {
    assert.strictEqual(update.installLanded({ attempt: { version: installed }, version: running }), null,
      `${running} vs ${installed}`);
  }
  assert.strictEqual(update.olderThan('1.6.6', '1.6.8'), true);
  assert.strictEqual(update.olderThan('1.6.10', '1.6.9'), false, 'dot parts compare as numbers, not text');
  assert.strictEqual(update.olderThan('1.6.8', '1.6.8'), false);
});

test('the message names the folder to install over', () => {
  const said = update.misplacedMessage({ expected: '1.6.8', running: '1.6.6', directory: 'D:\\Games\\Ragnarok Offline' });
  assert.match(said, /1\.6\.8 installed somewhere else/);
  assert.match(said, /still 1\.6\.6/);
  assert.match(said, /over D:\\Games\\Ragnarok Offline/);
  // No folder recorded: still a usable sentence.
  assert.match(update.misplacedMessage({ expected: '1.6.8', running: '1.6.6', directory: null }),
    /over the folder this copy runs from/);
});

// The record has to be written before the installer runs, because after it
// runs this process is gone.
test('Windows writes down the version it expects next, before handing over', async () => {
  const t = make({ platform: 'win32' });
  await downloaded(t);
  await t.u.finishQuit({ restartRequested: true, relaunch: false });
  assert.strictEqual(t.record.saved.version, '1.6.3');
  assert.strictEqual(t.record.saved.directory, 'D:\\Games\\Ragnarok Offline');
  assert.match(t.record.saved.at, /^\d{4}-\d\d-\d\dT/);
});

// macOS replaces the bundle in place and the AppImage rewrites itself; neither
// can land anywhere else, so neither needs watching.
test('only Windows records an attempt', async () => {
  for (const platform of ['darwin', 'linux']) {
    const t = make({ platform });
    await downloaded(t);
    await t.u.finishQuit({ restartRequested: true, relaunch: false });
    assert.strictEqual(t.record.saved, null, platform);
  }
});

test('on the next start a missed update is reported once and the record cleared', () => {
  const t = make({ platform: 'win32', record: { version: '1.6.8', directory: 'D:\\Games\\Ragnarok Offline' } });
  t.u.start();
  assert.ok(t.u.status().misplaced, 'not noticed');
  assert.match(t.u.status().misplacedMessage, /installed somewhere else/);
  assert.strictEqual(t.record.cleared, true, 'a stale record would accuse the next release too');
  assert.ok(t.logs.some(l => /installed somewhere else/.test(l)), 'not logged');
});

test('an update that landed says so and leaves no warning', () => {
  const t = make({ platform: 'win32', record: { version: '1.6.2', directory: 'D:\\Games\\Ragnarok Offline' } });
  t.u.start();
  assert.strictEqual(t.u.status().misplaced, null);
  assert.strictEqual(t.u.status().misplacedMessage, null);
  assert.strictEqual(t.record.cleared, true);
});

// Unattended, installing again would make another stray copy on every quit and
// still never update the copy being used. Asked for explicitly, it goes ahead:
// the player may have just reinstalled over the right folder.
test('install-on-quit stops while misplaced; Restart to install does not', () => {
  const base = { ready: true, relaunch: false };
  assert.strictEqual(update.quitPlan({ ...base, installOnQuit: true, restartRequested: false, misplaced: null }), 'install');
  assert.strictEqual(update.quitPlan({ ...base, installOnQuit: true, restartRequested: false, misplaced: { expected: '1.6.8' } }), 'exit');
  assert.strictEqual(update.quitPlan({ ...base, installOnQuit: true, restartRequested: true, misplaced: { expected: '1.6.8' } }), 'install-relaunch');
  assert.strictEqual(update.quitPlan({ ...base, installOnQuit: false, restartRequested: true, misplaced: { expected: '1.6.8' } }), 'install-relaunch');
});

test('a suppressed install-on-quit says why', async () => {
  const t = make({ platform: 'win32', installOnQuit: true, record: { version: '1.6.8', directory: 'D:\\G\\RO' } });
  t.u.start();
  await downloaded(t);
  assert.strictEqual(await t.u.finishQuit({ restartRequested: false, relaunch: false }), 'none');
  assert.ok(t.logs.some(l => /not installing on quit/.test(l)), t.logs.join('\n'));
});

// The one failure a player cannot work out alone has to be where they look.
test('the Settings window shows the warning, not just the log', () => {
  const page = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/settings.html'), 'utf8');
  assert.match(page, /id="app-update-misplaced"/);
  assert.match(page, /\$\('app-update-misplaced'\)\.textContent = u\.misplacedMessage \|\| '';/);
  assert.match(page, /\$\('app-update-misplaced'\)\.hidden = !u\.misplacedMessage;/);
});

// The record lives in the state folder main.js resolves, not Electron's
// userData: a second copy run with RAGNAROKMAC_STATE has its own.
test('main.js gives the updater the state folder for the record', () => {
  const main = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../electron/main.js'), 'utf8');
  assert.match(main, /installRecord: update\.fileInstallRecord\(stateDir\)/);
});

test('the record store never throws, whatever the disk does', () => {
  const store = update.fileInstallRecord(() => '/nonexistent-\u0000-path');
  assert.strictEqual(store.read(), null);
  assert.doesNotThrow(() => store.write({ version: '1.6.8' }));
  assert.doesNotThrow(() => store.clear());
});
