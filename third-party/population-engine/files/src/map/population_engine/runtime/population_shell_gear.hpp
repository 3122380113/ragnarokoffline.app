// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companions start unequipped): a companion the engine never dresses.
//
// The engine dresses a drafted companion from its job's gear set, and again at a job change
// and wherever a slot is found empty. Settings -> Population -> Companions start unequipped
// (population_engine_companion_start_unequipped, off by default) drafts a companion with
// nothing on instead, and from then on the engine gives that companion no gear at all: what it
// wears is what its owner gave it. The companion remembers how it was drafted
// (cp_companion_persistence.start_unequipped), so the setting changes no existing companion.
//
// It is also what lets a plan switch gear later: with nothing of the engine's on it, every
// piece a companion wears or carries is its owner's, and none has to be told apart.
//
// Ammunition and potions are not gear here; they keep their own settings.
#pragma once

#include <common/cbasetypes.hpp>

class map_session_data;

/// True for a companion that was drafted unequipped: the engine dresses it nowhere.
bool population_shell_gear_bare(const map_session_data *sd);
/// A companion has just been drafted and its row exists. With the setting on, it loses what
/// the spawn dressed it in and is marked, in memory and in its row.
void population_shell_gear_drafted(map_session_data *shell);
/// A saved companion has just been spawned for a recall, before the recall dresses it: reads
/// how it was drafted from its row.
void population_shell_gear_recalled(map_session_data *shell);
