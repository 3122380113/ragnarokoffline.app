// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companions start unequipped): see population_shell_gear.hpp.

#include "population_shell_gear.hpp"

#include <unordered_map>

#include <common/showmsg.hpp>
#include <common/sql.hpp>
#include <common/timer.hpp>

#include "../../battle.hpp"
#include "../../itemdb.hpp"
#include "../../log.hpp"
#include "../../map.hpp"
#include "../../pc.hpp"
#include "../../status.hpp"
#include "../../population_engine.hpp"

namespace {

/// char_id -> when it was marked. A companion's char id is its shell index, and an index is
/// handed to an ambient shell again once the companion's row is gone; a mark nobody claims as a
/// companion within kClaimMs is that kind of leftover and is dropped.
std::unordered_map<uint32, t_tick> g_bare;
constexpr t_tick kClaimMs = 5000;

uint32 index_of(const map_session_data *sd)
{
	return sd->status.char_id >= POPULATION_ENGINE_CHAR_ID_BASE ? sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE : 0;
}

/// Everything the spawn dressed it in goes: worn or not, costume and shadow pieces too.
/// Ammunition stays (population_shell_ammo and the inventory setting look after it).
void strip(map_session_data *sd)
{
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const item &it = sd->inventory.u.items_inventory[i];
		if (it.nameid == 0 || it.amount <= 0)
			continue;
		const std::shared_ptr<item_data> id = itemdb_exists(it.nameid);
		if (id == nullptr || !itemdb_isequip2(id.get()) || (id->equip & EQP_AMMO))
			continue;
		if (it.equip != 0 && !pc_unequipitem(sd, i, 2))
			continue;
		pc_delitem(sd, i, sd->inventory.u.items_inventory[i].amount, 0, 1, LOG_TYPE_NONE);
	}
	status_calc_pc(sd, SCO_FORCE);
}

} // namespace

bool population_shell_gear_bare(const map_session_data *sd)
{
	if (sd == nullptr || g_bare.empty() || !population_engine_is_population_pc(sd->id))
		return false;
	const auto it = g_bare.find(sd->status.char_id);
	if (it == g_bare.end())
		return false;
	if (population_engine_is_recruited_companion(sd))
		return true;
	// Not a companion (yet): a recall marks the shell a moment before it gives it its owner.
	if (DIFF_TICK(gettick(), it->second) <= kClaimMs)
		return true;
	g_bare.erase(it);
	return false;
}

void population_shell_gear_drafted(map_session_data *shell)
{
	if (shell == nullptr || index_of(shell) == 0)
		return;
	g_bare.erase(shell->status.char_id);
	if (!battle_config.population_engine_companion_start_unequipped)
		return;
	strip(shell);
	g_bare[shell->status.char_id] = gettick();
	if (mmysql_handle != nullptr && Sql_Query(mmysql_handle,
			"UPDATE `cp_companion_persistence` SET start_unequipped=1 WHERE shell_index=%u", index_of(shell)) != SQL_SUCCESS)
		Sql_ShowDebug(mmysql_handle);
	// The row was written with what the spawn put on: write it again with nothing.
	population_engine_persist_companion_gear(shell);
	ShowInfo("population_engine: companion %u starts unequipped\n", shell->status.char_id);
}

void population_shell_gear_recalled(map_session_data *shell)
{
	if (shell == nullptr || index_of(shell) == 0)
		return;
	g_bare.erase(shell->status.char_id);
	if (mmysql_handle == nullptr)
		return;
	if (Sql_Query(mmysql_handle,
			"SELECT start_unequipped FROM `cp_companion_persistence` WHERE shell_index=%u", index_of(shell)) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle); // a database from before the column: dressed, as it always was
		return;
	}
	bool bare = false;
	if (Sql_NextRow(mmysql_handle) == SQL_SUCCESS) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		bare = data != nullptr && atoi(data) != 0;
	}
	Sql_FreeResult(mmysql_handle);
	if (bare)
		g_bare[shell->status.char_id] = gettick();
}
