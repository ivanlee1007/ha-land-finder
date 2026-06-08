from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant

from .const import (
    CONF_AUTO_INSTALL,
    CONF_AUTO_START,
    CONF_AUTO_UPDATE,
    CONF_MYSQL_URL,
    CONF_NODE_BINARY,
    CONF_NPM_BINARY,
    CONF_PORT,
    CONF_REPO_URL,
    CONF_WORKDIR,
    DEFAULT_MYSQL_URL,
    DEFAULT_PORT,
    DEFAULT_REPO_URL,
    DEFAULT_WORKDIR,
)

_LOGGER = logging.getLogger(__name__)


class LandFinderError(RuntimeError):
    """Raised when the Land Finder child process cannot be managed."""


class LandFinderManager:
    """Install and supervise the Node.js 591 Land Finder web app."""

    def __init__(self, hass: HomeAssistant, entry) -> None:
        self.hass = hass
        self.entry = entry
        self.process: asyncio.subprocess.Process | None = None
        self.last_error: str | None = None
        self._lock = asyncio.Lock()

    @property
    def options(self) -> dict[str, Any]:
        return {**self.entry.data, **self.entry.options}

    @property
    def repo_url(self) -> str:
        return str(self.options.get(CONF_REPO_URL) or DEFAULT_REPO_URL)

    @property
    def port(self) -> int:
        return int(self.options.get(CONF_PORT) or DEFAULT_PORT)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def node_binary(self) -> str:
        return str(self.options.get(CONF_NODE_BINARY) or "node")

    @property
    def npm_binary(self) -> str:
        return str(self.options.get(CONF_NPM_BINARY) or "npm")

    @property
    def mysql_url(self) -> str:
        return str(os.environ.get("LAND_FINDER_MYSQL_URL") or os.environ.get("MYSQL_URL") or self.options.get(CONF_MYSQL_URL) or DEFAULT_MYSQL_URL)

    @property
    def repo_dir(self) -> Path:
        configured = str(self.options.get(CONF_WORKDIR) or DEFAULT_WORKDIR)
        path = Path(configured)
        if path.is_absolute():
            return path
        return Path(self.hass.config.path(configured))

    @property
    def app_dir(self) -> Path:
        return self.repo_dir / "assets" / "591-land-finder"

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["PORT"] = str(self.port)
        env["MYSQL_URL"] = self.mysql_url
        env.setdefault("LAND_FINDER_MANAGED_BY", "home-assistant")
        return env

    async def _run(self, *args: str, cwd: Path | None = None, timeout: int = 300) -> str:
        _LOGGER.debug("Running command: %s", " ".join(args))
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd) if cwd else None,
            env=self.env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError as err:
            proc.kill()
            await proc.wait()
            raise LandFinderError(f"Command timed out: {' '.join(args)}") from err
        text = out.decode(errors="replace") if out else ""
        if proc.returncode:
            raise LandFinderError(f"Command failed ({proc.returncode}): {' '.join(args)}\n{text[-4000:]}")
        return text

    async def async_install_or_update(self, force_update: bool = False) -> None:
        self.repo_dir.parent.mkdir(parents=True, exist_ok=True)
        if not (self.repo_dir / ".git").exists():
            if not self.options.get(CONF_AUTO_INSTALL, True):
                raise LandFinderError(f"Land Finder source is missing: {self.repo_dir}")
            await self._run("git", "clone", self.repo_url, str(self.repo_dir), cwd=self.repo_dir.parent, timeout=600)
        elif force_update or self.options.get(CONF_AUTO_UPDATE, False):
            await self._run("git", "pull", "--ff-only", cwd=self.repo_dir, timeout=300)

        if not self.app_dir.exists():
            raise LandFinderError(f"Land Finder app directory is missing: {self.app_dir}")

        if not (self.app_dir / "node_modules").exists() and self.options.get(CONF_AUTO_INSTALL, True):
            await self._run(self.npm_binary, "install", cwd=self.app_dir, timeout=900)

    async def async_init_db(self) -> None:
        await self._run(self.npm_binary, "run", "init-db", cwd=self.app_dir, timeout=300)

    async def async_start(self) -> None:
        async with self._lock:
            self.last_error = None
            if self.running:
                return
            try:
                await self.async_install_or_update()
                await self.async_init_db()
                self.process = await asyncio.create_subprocess_exec(
                    self.npm_binary,
                    "run",
                    "serve",
                    cwd=str(self.app_dir),
                    env=self.env(),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                self.hass.async_create_task(self._watch_process())
                await asyncio.sleep(2)
                if self.process.returncode is not None:
                    raise LandFinderError("Land Finder exited immediately after start")
            except Exception as err:  # noqa: BLE001 - surfaced in HA diagnostics/entities
                self.last_error = str(err)
                _LOGGER.exception("Failed to start Land Finder")
                raise

    async def _watch_process(self) -> None:
        proc = self.process
        if proc is None or proc.stdout is None:
            return
        tail: list[str] = []
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode(errors="replace").rstrip()
                tail.append(text)
                tail = tail[-30:]
                _LOGGER.debug("land-finder: %s", text)
            code = await proc.wait()
            if self.process is proc:
                self.process = None
            if code not in (0, None):
                self.last_error = f"Land Finder exited with {code}: " + "\n".join(tail[-8:])
                _LOGGER.warning(self.last_error)
        except Exception as err:  # noqa: BLE001
            self.last_error = str(err)
            _LOGGER.exception("Error watching Land Finder process")

    async def async_stop(self) -> None:
        async with self._lock:
            proc = self.process
            if proc is None:
                return
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=15)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            if self.process is proc:
                self.process = None

    async def async_restart(self) -> None:
        await self.async_stop()
        await self.async_start()

    async def async_runtime_status(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "running": self.running,
            "url": self.base_url,
            "port": self.port,
            "repo_dir": str(self.repo_dir),
            "app_dir": str(self.app_dir),
            "last_error": self.last_error,
        }
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(f"{self.base_url}/api/runtime-config") as resp:
                    if resp.status == 200:
                        payload = await resp.json()
                        data["reachable"] = True
                        data["job"] = payload.get("job", {}).get("status") if isinstance(payload.get("job"), dict) else None
                        data["runtime_config"] = payload.get("config", {})
                    else:
                        data["reachable"] = False
                        data["http_status"] = resp.status
        except Exception as err:  # noqa: BLE001
            data["reachable"] = False
            data["http_error"] = str(err)
        return data
