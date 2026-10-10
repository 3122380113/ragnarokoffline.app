// Guards for "Companions start unequipped": a companion the engine never dresses.
//
// The engine dresses a drafted companion from its job's gear set, and again at a job change and
// wherever it finds a slot empty. With the setting on a companion is drafted with nothing on and
// stays the owner's to dress. The risks these pin down: a dressing path that forgets to ask; the
// setting reaching companions that already exist; a stale mark on an ambient shell that was
// handed a deleted companion's index; and the table a fresh install and an upgraded one end with.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const MAP = 'third-party/population-engine/files/src/map/';
const gear = read(MAP + 'population_engine/runtime/population_shell_gear.cpp');
const engine = read(MAP + 'population_engine.cpp');
const factory = read(MAP + 'population_engine/population_engine_factory.cpp');
const patch = read('third-party/population-engine/patches/0036-companions-start-unequipped.patch');
const schema = read('third-party/population-engine/files/sql-files/population_engine/cp_companion_persistence.sql');
const cmds = read('stack/src/cmds.rs');
const settings = read('src/settings.html');
const main = read('electron/main.js');
const { lines, companionStartUnequipped } = require('../electron/population-conf');

const body = (src, signature) => {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `${signature} exists`);
	const open = src.indexOf('\n{', start);
	return src.slice(open, src.indexOf('\n}', open));
};

test('the module is part of the engine build', () => {
	assert.match(factory, /^#include "runtime\/population_shell_gear\.cpp"/m);
});

test('the server option is registered, off by default, 0 to 1', () => {
	assert.match(patch, /^\+\{ "population_engine_companion_start_unequipped",&battle_config\.population_engine_companion_start_unequipped,0,0,1,\},$/m);
	assert.match(patch, /^\+int32 population_engine_companion_start_unequipped;$/m);
});

test('the setting acts at the draft only; a recall reads how the companion was drafted', () => {
	const drafted = body(gear, 'void population_shell_gear_drafted(');
	assert.match(drafted, /if \(!battle_config\.population_engine_companion_start_unequipped\)\n\t\treturn;/);
	assert.match(drafted, /SET start_unequipped=1 WHERE shell_index=%u/);
	const recalled = body(gear, 'void population_shell_gear_recalled(');
	assert.doesNotMatch(recalled, /battle_config/);
	assert.match(recalled, /SELECT start_unequipped FROM `cp_companion_persistence` WHERE shell_index=%u/);
});

test('every way the engine dresses a companion asks first', () => {
	// The one function every gear-set piece goes through, and the refill of empty slots.
	assert.match(body(engine, 'static void population_engine_shell_equip_item('), /if \(population_shell_gear_bare\(sd\)\)\n\t\treturn;/);
	assert.match(body(engine, 'static void pop_companion_reequip_own('), /if \(population_shell_gear_bare\(shell\)\)\n\t\treturn;/);
	// Draft: after the row exists. Recall: before the first piece goes on.
	assert.match(engine, /population_engine_persist_companion_row\(shell, owner\);\n[^\n]*\n\tpopulation_shell_gear_drafted\(shell\);/);
	assert.match(engine, /population_shell_gear_recalled\(shell\);\n\tpopulation_engine_shell_equip_item\(shell, armor, index_, "armor"\);/);
});

test('the strip takes equipment and leaves ammunition', () => {
	const strip = body(gear, 'void strip(');
	assert.match(strip, /!itemdb_isequip2\(id\.get\(\)\) \|\| \(id->equip & EQP_AMMO\)/);
	assert.match(strip, /pc_unequipitem\(sd, i, 2\)/);
});

test('a mark no companion claims is dropped, so an ambient shell on a reused index is dressed', () => {
	const bare = body(gear, 'bool population_shell_gear_bare(');
	assert.match(bare, /if \(population_engine_is_recruited_companion\(sd\)\)\n\t\treturn true;/);
	assert.match(bare, /g_bare\.erase\(it\);\n\treturn false;/);
});

test('a fresh install and an upgraded one both have the column', () => {
	assert.match(schema, /`start_unequipped`\s+TINYINT\s+NOT NULL DEFAULT 0,/);
	assert.match(cmds, /\("start_unequipped", "TINYINT NOT NULL DEFAULT 0"\),/);
});

test('Settings offers the choice, off by default, and writes it', () => {
	assert.match(main, /population_companion_start_unequipped: false,/);
	assert.match(settings, /id="population_companion_start_unequipped"/);
	assert.match(settings, /settings\.population_companion_start_unequipped = \$\('population_companion_start_unequipped'\)\.checked;/);
	assert.match(settings, /\$\('population_companion_start_unequipped'\)\.checked = s\.population_companion_start_unequipped === true;/);
	assert.match(settings, /id="companion-start-unequipped-note"/);
	assert.equal(companionStartUnequipped({}), 0);
	assert.equal(companionStartUnequipped({ population_companion_start_unequipped: true }), 1);
	const base = { population_enable: true, population_max: 1500, population_density: 100 };
	assert.match(lines(base), /^population_engine_companion_start_unequipped: 0$/m);
	assert.match(lines({ ...base, population_companion_start_unequipped: true }), /^population_engine_companion_start_unequipped: 1$/m);
});
