# Changelog

## 0.2.2

- Add `jq` to the image so the fallback options reader works when the base image does not provide bashio.

## 0.2.1

- Use official Home Assistant architecture-specific base images for add-on builds.

## 0.2.0

- Convert repository from a custom integration/HACS package into a Home Assistant add-on repository.
- Add supervised add-on container with Node.js, npm, git, MariaDB service support, ingress, and auto-start behavior.

## 0.1.0

- Initial custom integration prototype.
