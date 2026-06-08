from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries

from .const import (
    CONF_AUTO_INSTALL,
    CONF_AUTO_START,
    CONF_AUTO_UPDATE,
    CONF_MYSQL_URL,
    CONF_NODE_BINARY,
    CONF_NPM_BINARY,
    CONF_PANEL_PATH,
    CONF_PANEL_URL,
    CONF_PORT,
    CONF_REPO_URL,
    CONF_WORKDIR,
    DEFAULT_MYSQL_URL,
    DEFAULT_PANEL_PATH,
    DEFAULT_PORT,
    DEFAULT_REPO_URL,
    DEFAULT_WORKDIR,
    DOMAIN,
)


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    d = defaults or {}
    return vol.Schema(
        {
            vol.Optional(CONF_REPO_URL, default=d.get(CONF_REPO_URL, DEFAULT_REPO_URL)): str,
            vol.Optional(CONF_WORKDIR, default=d.get(CONF_WORKDIR, DEFAULT_WORKDIR)): str,
            vol.Optional(CONF_PORT, default=d.get(CONF_PORT, DEFAULT_PORT)): int,
            vol.Optional(CONF_MYSQL_URL, default=d.get(CONF_MYSQL_URL, DEFAULT_MYSQL_URL)): str,
            vol.Optional(CONF_NODE_BINARY, default=d.get(CONF_NODE_BINARY, "node")): str,
            vol.Optional(CONF_NPM_BINARY, default=d.get(CONF_NPM_BINARY, "npm")): str,
            vol.Optional(CONF_PANEL_URL, default=d.get(CONF_PANEL_URL, "/api/ha_land_finder/proxy/")): str,
            vol.Optional(CONF_PANEL_PATH, default=d.get(CONF_PANEL_PATH, DEFAULT_PANEL_PATH)): str,
            vol.Optional(CONF_AUTO_START, default=d.get(CONF_AUTO_START, True)): bool,
            vol.Optional(CONF_AUTO_INSTALL, default=d.get(CONF_AUTO_INSTALL, True)): bool,
            vol.Optional(CONF_AUTO_UPDATE, default=d.get(CONF_AUTO_UPDATE, False)): bool,
        }
    )


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        if user_input is not None:
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured(updates=user_input)
            return self.async_create_entry(title="Land Finder", data=user_input)
        return self.async_show_form(step_id="user", data_schema=_schema())

    @staticmethod
    def async_get_options_flow(config_entry):
        return OptionsFlow(config_entry)


class OptionsFlow(config_entries.OptionsFlow):
    def __init__(self, config_entry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        defaults = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=_schema(defaults))
