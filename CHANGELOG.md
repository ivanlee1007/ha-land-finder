# Changelog

## 0.3.1

- Use relative browser fetch URLs so API calls and town map JSON load correctly through Home Assistant ingress.

## 0.3.0

- Bundle the Land Finder Node app inside the add-on image so HA OS does not need runtime GitHub access to the source repository.

## 0.2.4

- Avoid sourcing bashio directly; read add-on options with jq to prevent bashio source-context startup failures.

## 0.2.3

- Map `/share` and tee runtime logs to `/share/land-finder.log` for troubleshooting on HA OS.

## 0.2.2

- Add `jq` to the image so the fallback options reader works when the base image does not provide bashio.

## 0.2.1

- Use official Home Assistant architecture-specific base images for add-on builds.

## 0.2.0

- Convert repository from a custom integration/HACS package into a Home Assistant add-on repository.
- Add supervised add-on container with Node.js, npm, git, MariaDB service support, ingress, and auto-start behavior.

## 0.1.0

- Initial custom integration prototype.
