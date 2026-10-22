'use strict';
//
// Updating the app itself from its GitHub releases (electron-updater).
//
// Releases are daily, so asking players to download a 240 MB installer by hand
// every day leaves most of them a week or more behind. This checks the latest
// release, downloads the update in the background, and installs it only when
// the player says so:
//
//   - Settings -> General -> Updates -> "Restart to install". The server is
//     stopped the normal way first (before-quit's teardown), then the installer
//     runs and the app comes back on the new version.
//   - Or, with "Automatically install updates on restart of app" ticked (off by
//     default), on an ordinary quit, after the same teardown.
//
// Nothing else installs one. A downloaded update otherwise waits, with a badge
// on the General tab, and a newer release replaces it when it comes out.
//
// Why electron-updater rather than Electron's own autoUpdater: the built-in
// one needs Squirrel.Windows, not the NSIS installer we ship (installer.nsh,
// the install directory choice), and a feed server for Squirrel.Mac. This reads
// the latest*.yml files electron-builder writes next to the installers, from
// the release GitHub marks Latest -- never the `images` release, which is not
// marked Latest and carries no latest*.yml.
//
// macOS is the subtle one. Squirrel.Mac installs a *staged* update whenever the
// app exits, and electron-updater stages at download time when
// autoInstallOnAppQuit is set. A staged update cannot be withdrawn, so turning
// the setting off afterwards would not stop it. So on macOS the library's flag
// stays false, nothing is staged in the background, and staging happens here,
// at quit, only when this file has decided to install.
//
const CHECK_FIRST_MS = 30 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
// Squirrel.Mac copies and verifies the whole update before it reports it
// staged; on a slow disk that is tens of seconds.
const STAGE_TIMEOUT_MS = 3 * 60 * 1000;

// Whether this copy can update itself at all, and if not, why (for the log and
// the Settings line).
function availability({ packaged, headless, platform, appImage, adHocSigned, hasUpdateConfig }) {
	if (!packaged) return { ok: false, reason: 'running from source' };
	if (headless) return { ok: false, reason: 'headless' };
	if (!hasUpdateConfig) return { ok: false, reason: 'this build has no update feed' };
	if (platform === 'darwin' && adHocSigned) return { ok: false, reason: 'this build is not signed with a Developer ID' };
	if (platform === 'linux' && !appImage) return { ok: false, reason: 'only the AppImage updates itself' };
	if (!['darwin', 'win32', 'linux'].includes(platform)) return { ok: false, reason: `not supported on ${platform}` };
	return { ok: true, reason: '' };
}

// What to do once the server has stopped and the app is about to exit.
//   'exit'             no update, or the player has not asked for one
//   'install'          install, and do not start the app again
//   'install-relaunch' install, then start the new version
// `relaunch` is a launch that arrived during the quit (main.js's
// second-instance handler): the installer starts the app instead, so two
// copies do not race the files being replaced.
// `misplaced` is set when the last install landed in another folder. An
// explicit "Restart to install" still goes ahead -- the player asked, and they
// may have just reinstalled over the right folder -- but the automatic
// install-on-quit does not, because unattended it would make another stray
// copy on every quit and never update the copy being used.
function quitPlan({ ready, restartRequested, installOnQuit, relaunch, misplaced }) {
	if (!ready) return 'exit';
	if (restartRequested) return 'install-relaunch';
	if (installOnQuit) return misplaced ? 'exit' : (relaunch ? 'install-relaunch' : 'install');
	return 'exit';
}

// electron-updater's own install-on-quit flag. Never on macOS (see the top of
// this file); elsewhere it follows the setting, so its quit handler and ours
// agree, and install() refuses to run twice.
function libraryInstallOnQuit(platform, installOnQuit) {
	return platform !== 'darwin' && !!installOnQuit;
}

// Where the Windows installer should put an update: the folder this copy runs
// from. Left to itself, the NSIS installer works its folder out again from the
// registry and the install mode (per user or for everyone), and for a player
// who installed onto another drive it can work out the default instead -- the
// update lands in AppData and the copy they use is left behind (#632). /D
// overrides whatever it works out; electron-updater passes it from
// installDirectory. null when the folder is not known.
function windowsInstallDirectory(execPath) {
	if (!execPath) return null;
	return require('node:path').win32.dirname(execPath);
}

// Whether a recorded install attempt actually landed on this copy.
//
// The reason this exists: on Windows the NSIS installer decides its own
// destination, and `installDirectory` (the /D switch) is a request, not a
// guarantee. When it lands somewhere else the update *succeeds* -- a second
// copy of the app appears in the default folder, fully updated -- and the copy
// the player launches is untouched. Nothing anywhere said so, so the player
// sees "the updater reinstalls instead of updating" and tries again, and again
// (#632, still reported against 1.6.7 and 1.6.8).
//
// So: before handing over to the installer, write down the version we expect
// to be running next time. On the next start, if we are not running it, the
// update went somewhere else.
//
// Returns null when there is nothing to say -- no attempt recorded, or the
// version we hoped for is the version we got.
function installLanded({ attempt, version }) {
	if (!attempt || !attempt.version) return null;
	// Running the version we installed, or something newer still (a hand
	// installed release on top): it landed, or no longer matters.
	if (!olderThan(version, attempt.version)) return null;
	return { expected: attempt.version, running: version, directory: attempt.directory || null };
}

// `a` is an earlier release than `b`. Compares the numeric dot-parts and
// nothing else: these are our own release tags (1.6.8), and anything it cannot
// read counts as not-older, so a tag shape we have never seen reports no
// problem rather than a false one.
function olderThan(a, b) {
	// Every dot-part must be digits and nothing else. '' would otherwise read
	// as 0 and make any real version look newer than it, which would accuse a
	// release of failing on a copy that simply could not name itself.
	const parts = v => {
		const text = String(v == null ? '' : v).trim();
		if (!text) return null;
		const out = text.split('.').map(seg => (/^\d+$/.test(seg) ? Number(seg) : NaN));
		return out.every(Number.isFinite) ? out : null;
	};
	const x = parts(a), y = parts(b);
	if (!x || !y) return false;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] || 0) - (y[i] || 0);
		if (d) return d < 0;
	}
	return false;
}

// What to tell the player, in one line they can act on. Named folder first:
// the whole confusion is not knowing which copy is which.
function misplacedMessage({ expected, running, directory }) {
	const where = directory ? ` over ${directory}` : ' over the folder this copy runs from';
	return `Update ${expected} installed somewhere else -- this copy is still ${running}. `
		+ `Windows installers choose their own folder, and yours is not the default one. `
		+ `Download the installer from the releases page and run it${where}.`;
}

// Where the attempt is written down. A tiny JSON file in the state folder, so
// it survives the install and the restart. `directory` is a function because
// main.js resolves the state folder from RAGNAROKMAC_STATE, which a second
// copy of the app overrides.
//
// Guarded at every step: this is a diagnostic, and it must never be the reason
// the app will not start.
function fileInstallRecord(directory) {
	const file = () => {
		const fs = require('node:fs'), path = require('node:path');
		return { fs, path, at: path.join(directory(), 'update-attempt.json') };
	};
	return {
		read() {
			try {
				const { fs, at } = file();
				return JSON.parse(fs.readFileSync(at, 'utf8'));
			} catch { return null; }
		},
		write(attempt) {
			try {
				const { fs, path, at } = file();
				fs.mkdirSync(path.dirname(at), { recursive: true });
				fs.writeFileSync(at, JSON.stringify(attempt, null, 2) + '\n');
			} catch { /* a diagnostic; never fatal */ }
		},
		clear() {
			try {
				const { fs, at } = file();
				fs.rmSync(at, { force: true });
			} catch { /* as above */ }
		},
	};
}

function createAppUpdater({ app, platform = process.platform, execPath = process.execPath, log, preferences, availability: avail, load, nativeUpdater, installRecord = fileInstallRecord(() => require('node:path').join(app.getPath('userData'), 'state')), timers = { setTimeout, setInterval, clearTimeout } }) {
	const state = {
		enabled: avail.ok,
		reason: avail.reason,
		phase: avail.ok ? 'idle' : 'disabled', // idle checking downloading up-to-date error disabled
		percent: 0,
		available: null, // the version being downloaded
		ready: null, // the version downloaded and waiting
		checkedAt: null,
		error: null,
		// Set when the last install landed in another folder -- see
		// installLanded. Suppresses automatic install-on-quit, so the app
		// stops quietly making another copy on every restart.
		misplaced: null,
	};
	let updater = null;
	let checking = null;
	let interval = null;

	function lib() {
		if (updater) return updater;
		updater = load();
		// One line each: the library logs whole stack traces for an offline
		// check, every few hours.
		const line = m => log(`update: ${String((m && m.message) || m).split('\n')[0].slice(0, 300)}`);
		updater.logger = { info: line, warn: line, error: line, debug: () => {} };
		updater.autoDownload = true;
		updater.allowPrerelease = false;
		updater.allowDowngrade = false;
		updater.autoInstallOnAppQuit = libraryInstallOnQuit(platform, preferences().installOnQuit);
		if (platform === 'win32') {
			const dir = windowsInstallDirectory(execPath);
			if (dir) updater.installDirectory = dir;
		}
		updater.on('checking-for-update', () => { if (state.phase !== 'downloading') state.phase = 'checking'; });
		updater.on('update-available', info => {
			state.available = info.version;
			state.percent = 0;
			state.phase = 'downloading';
		});
		updater.on('update-not-available', () => { state.phase = 'up-to-date'; state.available = null; });
		updater.on('download-progress', p => { state.percent = Math.floor(p.percent || 0); });
		updater.on('update-downloaded', info => {
			state.ready = info.version;
			state.available = null;
			state.phase = 'idle';
			log(`update: ${info.version} downloaded; installs when you choose Restart to install`);
		});
		// Offline, a rate limit, a release still uploading: say it once in the
		// log and on the Settings line, and try again at the next check.
		updater.on('error', error => {
			state.error = shortError(error);
			state.phase = 'error';
			log(`update: ${state.error}`);
		});
		return updater;
	}

	function check() {
		if (!state.enabled) return Promise.resolve(status());
		if (checking) return checking;
		state.checkedAt = new Date().toISOString();
		state.error = null;
		checking = Promise.resolve()
			.then(() => lib().checkForUpdates())
			.catch(error => {
				// Usually already reported by the 'error' event above.
				if (state.phase === 'error') return;
				state.error = shortError(error);
				state.phase = 'error';
				log(`update: ${state.error}`);
			})
			.then(() => status())
			.finally(() => { checking = null; });
		return checking;
	}

	// Run once by start(), before the availability check: the message matters
	// most on a copy that cannot update itself. Returned as well so a caller
	// that does not start the timers can still ask.
	function reviewLastInstall() {
		const attempt = installRecord.read();
		if (!attempt) return state.misplaced;
		const missed = installLanded({ attempt, version: app.getVersion() });
		// Either way the record has served its purpose; a stale one would
		// accuse the next release of a failure that already got fixed.
		installRecord.clear();
		state.misplaced = missed;
		if (missed) log(`update: ${misplacedMessage(missed)}`);
		else log(`update: ${attempt.version} installed where this copy runs`);
		return state.misplaced;
	}

	function start() {
		reviewLastInstall();
		if (!state.enabled) {
			log(`update: automatic updates are off: ${state.reason}`);
			return;
		}
		const tick = () => { if (preferences().auto) check(); };
		timers.setTimeout(tick, CHECK_FIRST_MS);
		interval = timers.setInterval(tick, CHECK_EVERY_MS);
	}

	function preferencesChanged() {
		if (updater) updater.autoInstallOnAppQuit = libraryInstallOnQuit(platform, preferences().installOnQuit);
	}

	function status() {
		return {
			version: app.getVersion(),
			enabled: state.enabled,
			reason: state.reason,
			phase: state.phase,
			percent: state.percent,
			available: state.available,
			ready: state.ready,
			// A newer release replacing the waiting one: the old download is
			// gone while the new one comes in, so there is nothing to install.
			canInstall: !!state.ready && state.phase !== 'downloading',
			checkedAt: state.checkedAt,
			error: state.error,
			misplaced: state.misplaced,
			misplacedMessage: state.misplaced ? misplacedMessage(state.misplaced) : null,
			...preferences(),
		};
	}

	// Called by main.js once the teardown is done. Resolves to:
	//   'handed-off'  the updater is quitting the app itself (and starting it again)
	//   'installed'   the installer is running or the update is staged; exit, no relaunch
	//   'none'        nothing to install; exit as normal
	// `stuck` is called if a hand-off never ends in a quit (the installer
	// refused to start, Squirrel.Mac rejected the update), so the app is not
	// left sitting on "shutting down…" with its server already stopped.
	async function finishQuit({ restartRequested, relaunch, stuck = () => {} }) {
		const plan = quitPlan({
			ready: status().canInstall,
			restartRequested,
			installOnQuit: preferences().installOnQuit,
			relaunch,
			misplaced: state.misplaced,
		});
		if (plan === 'exit') {
			if (state.misplaced && preferences().installOnQuit) {
				log(`update: not installing on quit -- ${misplacedMessage(state.misplaced)}`);
			}
			return 'none';
		}
		const u = lib();
		// Written down before the installer runs, because after it runs this
		// process is gone. Windows only: it is the only installer that picks
		// its own folder (macOS replaces the bundle in place, the AppImage
		// rewrites itself).
		if (platform === 'win32') {
			installRecord.write({
				version: state.ready,
				directory: windowsInstallDirectory(execPath),
				at: new Date().toISOString(),
			});
		}
		try {
			if (plan === 'install-relaunch') {
				log(`update: installing ${state.ready} and restarting`);
				// Silent on Windows: the player already chose the folder, and
				// --updated keeps it. macOS ignores both arguments.
				let done = false;
				const give = error => {
					if (done) return;
					done = true;
					log(`update: install did not go ahead: ${shortError(error)}`);
					stuck();
				};
				timers.setTimeout(() => give(new Error('the installer did not take over in time')), STAGE_TIMEOUT_MS);
				u.once('error', give);
				u.quitAndInstall(true, true);
				return 'handed-off';
			}
			log(`update: installing ${state.ready} on quit`);
			if (platform === 'darwin') {
				await stageMac();
				return 'installed';
			}
			return u.install(true, false) ? 'installed' : 'none';
		} catch (error) {
			log(`update: could not install: ${shortError(error)}`);
			return 'none';
		}
	}

	// Hand the downloaded zip to Squirrel.Mac and wait until it is staged; it
	// installs when this process exits. electron-updater's proxy is already
	// serving the zip (it set the feed URL when the download finished).
	function stageMac() {
		return new Promise((resolve, reject) => {
			const timer = timers.setTimeout(() => reject(new Error('Squirrel.Mac did not stage the update in time')), STAGE_TIMEOUT_MS);
			nativeUpdater().once('update-downloaded', () => { timers.clearTimeout(timer); resolve(); });
			nativeUpdater().once('error', error => { timers.clearTimeout(timer); reject(error); });
			nativeUpdater().checkForUpdates();
		});
	}

	return { start, check, status, preferencesChanged, finishQuit, reviewLastInstall, _state: state };
}

function shortError(error) {
	const message = String((error && error.message) || error || 'unknown error');
	if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED/.test(message)) return 'offline, or GitHub could not be reached';
	if (/\b(403|429)\b/.test(message)) return 'GitHub is limiting requests; trying again later';
	if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|\b404\b/.test(message)) return 'the latest release has no update files yet';
	return message.split('\n')[0].slice(0, 200);
}

module.exports = { availability, quitPlan, libraryInstallOnQuit, windowsInstallDirectory, installLanded, olderThan, misplacedMessage, fileInstallRecord, createAppUpdater, shortError, CHECK_FIRST_MS, CHECK_EVERY_MS };
