from __future__ import annotations

import logging
from typing import Any

import aiohttp
from aiohttp import web

from homeassistant.components import frontend
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall

from .const import (
    CONF_AUTO_START,
    CONF_PANEL_PATH,
    CONF_PANEL_URL,
    DEFAULT_PANEL_PATH,
    DOMAIN,
    SERVICE_INIT_DB,
    SERVICE_RESTART,
    SERVICE_START,
    SERVICE_STOP,
    SERVICE_UPDATE,
)
from .manager import LandFinderManager

_LOGGER = logging.getLogger(__name__)
PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.SWITCH]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})
    manager = LandFinderManager(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = manager

    if len(hass.data[DOMAIN]) == 1:
        hass.http.register_view(LandFinderProxyView)
        _register_services(hass)

    panel_path = entry.options.get(CONF_PANEL_PATH) or entry.data.get(CONF_PANEL_PATH) or DEFAULT_PANEL_PATH
    panel_url = entry.options.get(CONF_PANEL_URL) or entry.data.get(CONF_PANEL_URL) or "/api/ha_land_finder/proxy/"
    try:
        await frontend.async_register_built_in_panel(
            hass,
            component_name="iframe",
            sidebar_title="Land Finder",
            sidebar_icon="mdi:map-search",
            frontend_url_path=panel_path,
            config={"url": panel_url, "require_admin": False},
        )
    except Exception:  # noqa: BLE001 - older HA versions may already have the panel
        _LOGGER.debug("Could not register Land Finder panel", exc_info=True)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    if entry.options.get(CONF_AUTO_START, entry.data.get(CONF_AUTO_START, True)):
        hass.async_create_task(manager.async_start())

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    manager: LandFinderManager | None = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    if manager:
        await manager.async_stop()
    try:
        frontend.async_remove_panel(hass, entry.options.get(CONF_PANEL_PATH) or entry.data.get(CONF_PANEL_PATH) or DEFAULT_PANEL_PATH)
    except Exception:  # noqa: BLE001
        pass
    return unload_ok


def _first_manager(hass: HomeAssistant) -> LandFinderManager:
    managers = hass.data.get(DOMAIN, {})
    if not managers:
        raise web.HTTPServiceUnavailable(text="HA Land Finder is not configured")
    return next(iter(managers.values()))


def _register_services(hass: HomeAssistant) -> None:
    async def handle(call: ServiceCall) -> None:
        manager = _first_manager(hass)
        if call.service == SERVICE_START:
            await manager.async_start()
        elif call.service == SERVICE_STOP:
            await manager.async_stop()
        elif call.service == SERVICE_RESTART:
            await manager.async_restart()
        elif call.service == SERVICE_UPDATE:
            await manager.async_install_or_update(force_update=True)
        elif call.service == SERVICE_INIT_DB:
            await manager.async_install_or_update()
            await manager.async_init_db()

    for service in [SERVICE_START, SERVICE_STOP, SERVICE_RESTART, SERVICE_UPDATE, SERVICE_INIT_DB]:
        if not hass.services.has_service(DOMAIN, service):
            hass.services.async_register(DOMAIN, service, handle)


class LandFinderProxyView(HomeAssistantView):
    """Authenticated reverse proxy to the local Land Finder web app."""

    url = "/api/ha_land_finder/proxy/{path:.*}"
    name = "api:ha_land_finder:proxy"
    requires_auth = True

    async def get(self, request: web.Request, path: str = "") -> web.Response:
        return await self._proxy(request, path)

    async def post(self, request: web.Request, path: str = "") -> web.Response:
        return await self._proxy(request, path)

    async def put(self, request: web.Request, path: str = "") -> web.Response:
        return await self._proxy(request, path)

    async def delete(self, request: web.Request, path: str = "") -> web.Response:
        return await self._proxy(request, path)

    async def _proxy(self, request: web.Request, path: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        manager = _first_manager(hass)
        target = f"{manager.base_url}/{path}"
        if request.query_string:
            target = f"{target}?{request.query_string}"
        body = await request.read()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in {"host", "content-length", "accept-encoding"}}
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(request.method, target, data=body or None, headers=headers) as resp:
                data = await resp.read()
                response_headers = {
                    k: v
                    for k, v in resp.headers.items()
                    if k.lower() not in {"content-encoding", "content-length", "connection", "transfer-encoding"}
                }
                return web.Response(status=resp.status, body=data, headers=response_headers)
