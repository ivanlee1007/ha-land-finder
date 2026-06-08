# 591 Land Finder Add-on

This Home Assistant add-on runs the 591 Taiwan land/house finder Node.js web app in its own container. It is intended for Home Assistant OS / Supervisor installations where running Node/npm from a custom integration is not reliable.

## Features

- Runs Land Finder as a supervised Home Assistant add-on.
- Starts automatically with Home Assistant when `boot: auto` is enabled.
- Uses Home Assistant ingress for sidebar access.
- Installs Node.js, npm, git, and MySQL client tools inside the add-on image.
- Clones/updates `ivanlee1007/land591-finder-skill` at runtime into persistent `/data`.
- Runs `npm install`, optional `npm run init-db`, then `npm run serve`.
- Uses the Home Assistant MariaDB service credentials when available.

## MariaDB

Install and start the MariaDB add-on first. This add-on declares:

```yaml
services:
  - mysql:need
```

When the Supervisor provides MariaDB credentials, the add-on builds `MYSQL_URL` automatically using the configured `database` option.

If your MariaDB setup requires a custom URL, set the `mysql_url` option directly, for example:

```text
mysql://land591:YOUR_PASSWORD@core-mariadb:3306/land591
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `source_repo` | `https://github.com/ivanlee1007/land591-finder-skill.git` | Source repository to clone. |
| `source_ref` | `main` | Branch, tag, or commit to use. |
| `auto_update` | `true` | Update the source checkout on add-on start. |
| `mysql_url` | empty | Optional full MySQL URL override. |
| `database` | `land591` | Database name when using Supervisor MariaDB credentials. |
| `run_init_db` | `true` | Run schema initialization before starting. |
| `max_pages_per_region` | `20` | Default scraper page limit. |

## Access

Use the Home Assistant sidebar item **Land Finder**. Direct access is also exposed on port `5910` if the port mapping is enabled.
