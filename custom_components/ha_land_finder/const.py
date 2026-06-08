from __future__ import annotations

DOMAIN = "ha_land_finder"
NAME = "HA Land Finder"
DEFAULT_REPO_URL = "https://github.com/ivanlee1007/land591-finder-skill.git"
DEFAULT_PORT = 5910
DEFAULT_PANEL_PATH = "land-finder"
DEFAULT_WORKDIR = "ha-land-finder/land591-finder-skill"
DEFAULT_MYSQL_URL = "mysql://land591:land591_local_pw@core-mariadb:3306/land591"

CONF_REPO_URL = "repo_url"
CONF_WORKDIR = "workdir"
CONF_PORT = "port"
CONF_MYSQL_URL = "mysql_url"
CONF_AUTO_START = "auto_start"
CONF_AUTO_UPDATE = "auto_update"
CONF_AUTO_INSTALL = "auto_install"
CONF_NODE_BINARY = "node_binary"
CONF_NPM_BINARY = "npm_binary"
CONF_PANEL_URL = "panel_url"
CONF_PANEL_PATH = "panel_path"

SERVICE_START = "start"
SERVICE_STOP = "stop"
SERVICE_RESTART = "restart"
SERVICE_UPDATE = "update"
SERVICE_INIT_DB = "init_db"
