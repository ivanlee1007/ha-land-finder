from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([LandFinderSwitch(hass.data[DOMAIN][entry.entry_id], entry)])


class LandFinderSwitch(SwitchEntity):
    _attr_name = "Land Finder Server"
    _attr_icon = "mdi:server"

    def __init__(self, manager, entry) -> None:
        self.manager = manager
        self._attr_unique_id = f"{entry.entry_id}_server"

    @property
    def is_on(self) -> bool:
        return self.manager.running

    async def async_turn_on(self, **kwargs) -> None:
        await self.manager.async_start()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        await self.manager.async_stop()
        self.async_write_ha_state()
