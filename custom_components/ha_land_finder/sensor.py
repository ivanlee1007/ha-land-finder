from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity, DataUpdateCoordinator

from .const import DOMAIN

SCAN_INTERVAL = 30


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    manager = hass.data[DOMAIN][entry.entry_id]
    coordinator = DataUpdateCoordinator(
        hass,
        logger=__import__("logging").getLogger(__name__),
        name="ha_land_finder_status",
        update_method=manager.async_runtime_status,
    )
    await coordinator.async_config_entry_first_refresh()
    async_add_entities([LandFinderStatusSensor(coordinator, entry), LandFinderUrlSensor(coordinator, entry)])


class LandFinderStatusSensor(CoordinatorEntity, SensorEntity):
    _attr_name = "Land Finder Status"
    _attr_icon = "mdi:home-search"

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_status"

    @property
    def native_value(self):
        data = self.coordinator.data or {}
        if data.get("reachable"):
            return "running"
        if data.get("running"):
            return "starting"
        return "stopped"

    @property
    def extra_state_attributes(self):
        return self.coordinator.data or {}


class LandFinderUrlSensor(CoordinatorEntity, SensorEntity):
    _attr_name = "Land Finder URL"
    _attr_icon = "mdi:web"

    def __init__(self, coordinator, entry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_url"

    @property
    def native_value(self):
        return (self.coordinator.data or {}).get("url")
