'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { commandSymbolConf, symbol, SYMBOLS, DEFAULT } = require('../electron/command-symbol');

const html = () => fs.readFileSync(path.join(__dirname, '../src/settings.html'), 'utf8');

// An install that never opens this setting must write what rAthena ships, so
// upgrading to the version that added it changes nothing for anybody.
test('an untouched install writes the stock symbol', () => {
	assert.equal(commandSymbolConf({}), 'atcommand_symbol: @\n');
	assert.equal(DEFAULT, '@');
});

test('each offered symbol is written as asked', () => {
	for (const command_symbol of SYMBOLS) {
		assert.equal(commandSymbolConf({ command_symbol }), `atcommand_symbol: ${command_symbol}\n`);
	}
});

// rAthena keeps the symbol it has when it does not like the new one, with no
// message -- so a damaged value has to land on '@', which is what the server
// would then be running on.
test('a damaged or unknown symbol falls back to the stock one', () => {
	for (const command_symbol of ['', '@@', 'storage', 64, null, undefined, [], {}, 'constructor', '__proto__']) {
		assert.equal(commandSymbolConf({ command_symbol }), 'atcommand_symbol: @\n', String(command_symbol));
	}
});

// The value is interpolated into a config file the map server reads, so a
// symbol carrying a newline would be extra battle settings -- rates included.
// The allowlist is what prevents it; this is the test that says so.
test('a symbol cannot smuggle further settings into battle_conf.txt', () => {
	for (const command_symbol of ['@\nbase_exp_rate: 10000', '!\nimport: /etc/passwd', '@ \n']) {
		const conf = commandSymbolConf({ command_symbol });
		assert.equal(conf.trim().split('\n').length, 1, command_symbol);
		assert.equal(conf, 'atcommand_symbol: @\n', command_symbol);
	}
});

// battle.cpp's battle_config_read rejects a control character, '/' (the
// client's own commands), '%' (party chat), '$' (guild chat) and whatever
// charcommand_symbol is -- '#', which the app never changes. Offering one of
// those would be offering a setting that does nothing.
test('no offered symbol is one the server refuses', () => {
	for (const s of SYMBOLS) {
		assert.equal(s.length, 1, s);
		const code = s.charCodeAt(0);
		assert.ok(code > 0x20 && code < 0x7f, `${s} is not printable ASCII`);
		assert.ok(!['/', '%', '$', '#'].includes(s), `${s} is reserved`);
	}
	assert.equal(new Set(SYMBOLS).size, SYMBOLS.length, 'the list repeats a symbol');
});

test('the stock symbol is offered, so a player can put it back', () => {
	assert.ok(SYMBOLS.includes(DEFAULT));
});

// The Settings window cannot require the module, so it carries its own copy of
// the list. Checked here so adding a symbol to one cannot leave the other
// behind -- which would show an option the server ignores, or hide one it takes.
test('the Settings window offers exactly the symbols the module allows', () => {
	const page = html();
	const copy = page.match(/^const COMMAND_SYMBOLS = \[([^\]]*)\];/m);
	assert.ok(copy, 'the window has no COMMAND_SYMBOLS list');
	assert.deepEqual(copy[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')), SYMBOLS);

	const picker = page.match(/<select id="command_symbol">([\s\S]*?)<\/select>/);
	assert.ok(picker, 'the window has no command_symbol picker');
	const offered = [...picker[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
	assert.deepEqual(offered, SYMBOLS, 'the picker and the module disagree');
});

// The one setting in this panel that is a string rather than a number or a
// checkbox, so it is the one most likely to be read but never written.
test('the Settings window both saves and loads the setting', () => {
	const page = html();
	assert.match(page, /settings\.command_symbol = \$\('command_symbol'\)\.value;/);
	assert.match(page, /\$\('command_symbol'\)\.value =/);
});

test('main.js writes it into battle_conf.txt and defaults it to the stock symbol', () => {
	const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
	assert.match(main, /require\('\.\/command-symbol'\)\.commandSymbolConf\(s\)/,
		'toBattleConf does not write the symbol');
	assert.match(main, /command_symbol: '@',/, 'SETTINGS_DEFAULTS does not carry the symbol');
});

test('symbol() is the one gate, and it is total', () => {
	assert.equal(symbol('!'), '!');
	assert.equal(symbol('/'), DEFAULT);
});
