# HA Land Finder

Home Assistant add-on repository for running the 591 Taiwan Land Finder web app.

## Add this repository to Home Assistant

1. In Home Assistant, open **Settings → Add-ons → Add-on Store**.
2. Open the three-dot menu and choose **Repositories**.
3. Add this repository URL:

   ```text
   https://github.com/ivanlee1007/ha-land-finder
   ```

4. Install **591 Land Finder**.
5. Make sure the MariaDB add-on is installed and running.
6. Start the add-on and open **Land Finder** from the sidebar.

## Repository contents

```text
repository.yaml
land-finder/
  config.yaml
  build.yaml
  Dockerfile
  run.sh
  README.md
  translations/
```

## Why this is an add-on, not only a custom integration

Land Finder is a Node.js web app that needs git, npm, Node.js, and MariaDB access. A Home Assistant add-on is a better fit than spawning Node processes from a custom integration, especially on Home Assistant OS / Supervisor installations.

The add-on runs the app in its own supervised container and exposes the UI through Home Assistant ingress.
