# HA Land Finder

Home Assistant custom integration wrapper for [`ivanlee1007/land591-finder-skill`](https://github.com/ivanlee1007/land591-finder-skill).

The integration supervises the existing Node.js 591 Land Finder web app and exposes it inside Home Assistant via a sidebar panel and authenticated reverse proxy.

## What it does

- Starts Land Finder when Home Assistant starts.
- Clones/updates the upstream Land Finder skill repo by default.
- Runs `npm install` when needed.
- Runs `npm run init-db` before serving.
- Starts `npm run serve` on the configured local port, default `5910`.
- Adds a Home Assistant sidebar panel: **Land Finder**.
- Provides status sensors and a server on/off switch.
- Provides services:
  - `ha_land_finder.start`
  - `ha_land_finder.stop`
  - `ha_land_finder.restart`
  - `ha_land_finder.update`
  - `ha_land_finder.init_db`

## Requirements

This is a **custom integration**, not a Home Assistant add-on image. The Home Assistant host/container must already have:

- `git`
- `node`
- `npm`
- a reachable MySQL/MariaDB server

You mentioned MySQL should already be installed in HA. The default connection string assumes a MariaDB add-on style hostname and a dedicated Land Finder database/user:

```text
mysql://land591:land591_local_pw@core-mariadb:3306/land591
```

If your Home Assistant MariaDB uses different credentials, set the integration option `mysql_url` accordingly or set the environment variable `LAND_FINDER_MYSQL_URL` / `MYSQL_URL` for Home Assistant. Do not commit real credentials.

## Install with HACS custom repository

1. Push or keep this repo at:
   `https://github.com/ivanlee1007/ha-land-finder`
2. In Home Assistant HACS, add it as a custom repository:
   - Repository: `https://github.com/ivanlee1007/ha-land-finder`
   - Category: Integration
3. Install **HA Land Finder**.
4. Restart Home Assistant.
5. Go to **Settings → Devices & services → Add integration → HA Land Finder**.

## Manual install

Copy this directory into Home Assistant config:

```text
/config/custom_components/ha_land_finder
```

Then restart Home Assistant and add the integration from the UI.

## Default options

| Option | Default |
|---|---|
| `repo_url` | `https://github.com/ivanlee1007/land591-finder-skill.git` |
| `workdir` | `/config/ha-land-finder/land591-finder-skill` |
| `port` | `5910` |
| `panel_url` | `/api/ha_land_finder/proxy/` |
| `panel_path` | `land-finder` |
| `auto_start` | `true` |
| `auto_install` | `true` |
| `auto_update` | `false` |

The proxy panel is relative to Home Assistant, so it works through the same HA URL you already use instead of requiring a separate browser-accessible `http://host:5910` URL.

## Database setup note

The upstream Land Finder project can create its own schema, but the MySQL database and user must exist first. Example for MariaDB/MySQL, adjust credentials to your environment:

```sql
CREATE DATABASE IF NOT EXISTS land591 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'land591'@'%' IDENTIFIED BY 'land591_local_pw';
GRANT ALL PRIVILEGES ON land591.* TO 'land591'@'%';
FLUSH PRIVILEGES;
```

## Limitations

- Home Assistant custom integrations cannot install OS packages by themselves. If `node`, `npm`, or `git` are missing, install them on the HA host or convert this project into a full HA add-on image.
- This wrapper starts the Node.js app as a child process of Home Assistant. For HA OS appliances, a Docker add-on may be more robust long term.
- Scraping hits external 591 endpoints. Keep the upstream delay/rate limiting behavior.

## Development checks

```bash
python -m compileall custom_components/ha_land_finder
python -m json.tool custom_components/ha_land_finder/manifest.json
python -m json.tool custom_components/ha_land_finder/translations/en.json
python -m json.tool custom_components/ha_land_finder/translations/zh-Hant.json
```
