```python
"""
src/constants.py
================

Centralised, project-wide constants and enumerations for *PrismPocket*.

Usage
-----
`constants` is intentionally dependency-free (std-lib only) so it can be
imported from anywhere in the project without causing circular-import hell.
Keep all *static* and *immutable* data here. Anything that requires I/O or
dynamic runtime evaluation belongs to `config.py` or a dedicated service
module instead.

Notes
-----
 • All string literals are single-source-of-truth to avoid tedious “hunt-and-replace”.
 • DO **NOT** mutate module-level attributes at runtime; treat them as read-only.
"""

from __future__ import annotations

import os
import platform
import uuid
from dataclasses import dataclass
from enum import Enum, IntEnum, auto
from pathlib import Path
from typing import Final, Optional

# ──────────────────────────────────────────────────────────────────────────────
# Application Metadata
# ──────────────────────────────────────────────────────────────────────────────

__all__: tuple[str, ...] = (
    "APP_NAME",
    "APP_PACKAGE",
    "APP_VERSION",
    "MINIMUM_OS_VERSION",
    "BUILD_FLAVOUR",
    "BuildFlavour",
    "Platform",
    "Environment",
    "DEFAULT_ENV",
    "EventTopic",
    "DEFAULT_TIMEOUT",
    "HTTP_RETRIES",
    "LOCAL_STORAGE_DIR",
    "CACHE_DIR",
    "CRASH_DUMP_DIR",
    "AnalyticsStream",
    "StickerPack",
    "DeviceFamily",
    "AppMeta",
    "app_meta",
)

# Semantic version of the shared Python core (mirrors native bundle versions).
APP_VERSION: Final[str] = "2.7.1"

# Marketing name (user-facing).
APP_NAME: Final[str] = "PrismPocket"

# Python package root.
APP_PACKAGE: Final[str] = "prism_pocket"

# Lowest mobile OS supported (native shell).
MINIMUM_OS_VERSION: Final[dict[str, str]] = {
    "ios": "15.0",
    "android": "7.1",
}

# ──────────────────────────────────────────────────────────────────────────────
# Build/Deploy Flavours
# ──────────────────────────────────────────────────────────────────────────────


class BuildFlavour(str, Enum):
    """
    Supported build channels.
    """

    ALPHA = "alpha"
    BETA = "beta"
    RELEASE = "release"

    def is_prerelease(self) -> bool:
        return self in {BuildFlavour.ALPHA, BuildFlavour.BETA}


class Environment(str, Enum):
    """
    Logical runtime environments.
    """

    LOCAL = "local"
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"

    @classmethod
    def from_str(cls, raw: Optional[str]) -> "Environment":
        try:
            return cls(raw.lower()) if raw else cls.LOCAL
        except (ValueError, AttributeError):
            # Fallback silently to LOCAL to prevent boot failure.
            return cls.LOCAL


# Set at packaging time by CI or fallback to env-var/user override.
DEFAULT_ENV: Final[Environment] = Environment.from_str(
    os.getenv("PRISM_ENV", "local")
)

BUILD_FLAVOUR: Final[BuildFlavour] = BuildFlavour(
    os.getenv("PRISM_BUILD_FLAVOUR", BuildFlavour.ALPHA.value)
)

# ──────────────────────────────────────────────────────────────────────────────
# Device + Platform metadata helpers
# ──────────────────────────────────────────────────────────────────────────────


class Platform(str, Enum):
    IOS = "ios"
    ANDROID = "android"
    DESKTOP = "desktop"  # Simulator / debug host

    @classmethod
    def current(cls) -> "Platform":
        name = platform.system().lower()
        if "darwin" in name and "iphone" in platform.platform().lower():
            return cls.IOS
        if "linux" in name or "android" in name:
            return cls.ANDROID
        return cls.DESKTOP


class DeviceFamily(str, Enum):
    """
    High-level device family buckets for runtime layout decisions.
    """

    PHONE = "phone"
    TABLET = "tablet"
    FOLDABLE = "foldable"


# ──────────────────────────────────────────────────────────────────────────────
# Observer/Event Bus Topics
# ──────────────────────────────────────────────────────────────────────────────


class EventTopic(str, Enum):
    """
    Canonical topic names for the reactive event bus.

    KEEP IN SYNC with Kotlin/Swift sidecar constants to guarantee
    cross-language topic parity.
    """

    # Prism card CRUD.
    CARD_CREATED = "card.created"
    CARD_UPDATED = "card.updated"
    CARD_DELETED = "card.deleted"
    CARD_SYNCED = "card.synced"

    # Analytics pipeline
    METRIC_PUSHED = "metric.pushed"

    # User sessions.
    SESSION_LOGIN = "session.login"
    SESSION_LOGOUT = "session.logout"

    # Background jobs.
    JOB_ENQUEUED = "job.enqueued"
    JOB_COMPLETED = "job.completed"
    JOB_FAILED = "job.failed"

    # Diagnostics.
    CRASH_LOGGED = "crash.logged"
    HEARTBEAT = "app.heartbeat"


# ──────────────────────────────────────────────────────────────────────────────
# Analytics
# ──────────────────────────────────────────────────────────────────────────────


class AnalyticsStream(IntEnum):
    """
    Numeric identifiers for analytics streams, used by the cloud pipeline
    for fast filtering.
    """

    CARD_INTERACTION = 101
    COLOR_PICKER = 102
    REMIX_SESSION = 103
    USER_BEHAVIOUR = 104
    ERROR = 900


# ──────────────────────────────────────────────────────────────────────────────
# UI / Asset Constants
# ──────────────────────────────────────────────────────────────────────────────

# Default UI palette (HEX values).
PALETTE_PRIMARY: Final[str] = "#5A31F4"
PALETTE_ACCENT: Final[str] = "#FFC93C"
PALETTE_BACKGROUND: Final[str] = "#FFFFFF"
PALETTE_SURFACE: Final[str] = "#F5F6FA"

# Sticker pack identifiers bundled with the app.
class StickerPack(str, Enum):
    BASICS = "basics"
    MEMES = "memes"
    TRAVEL = "travel"
    FINANCE = "finance"
    CUSTOM = "custom"


# ──────────────────────────────────────────────────────────────────────────────
# Networking constants
# ──────────────────────────────────────────────────────────────────────────────
DEFAULT_TIMEOUT: Final[int] = 10  # seconds
HTTP_RETRIES: Final[int] = 3

# Endpoints are environment-specific; left for runtime config resolution.
BASE_URL_PLACEHOLDER: Final[str] = "https://api.prismpocket.invalid"

# ──────────────────────────────────────────────────────────────────────────────
# Filesystem Paths
# ──────────────────────────────────────────────────────────────────────────────

# Root container (app sandbox or local user dir).
_SANDBOX_ROOT: Path = (
    Path.home() / ".prismpocket" if DEFAULT_ENV is Environment.LOCAL else Path("/data")
)

# All user-generated artefacts.
LOCAL_STORAGE_DIR: Final[Path] = _SANDBOX_ROOT / "cards"

# Transient cache (e.g., thumbnails, remote artefacts).
CACHE_DIR: Final[Path] = _SANDBOX_ROOT / "cache"

# Crash dumps before upload to server.
CRASH_DUMP_DIR: Final[Path] = _SANDBOX_ROOT / "crash_dumps"

# Ensure path existence silently; no fatal if read-only FS.
for _p in (LOCAL_STORAGE_DIR, CACHE_DIR, CRASH_DUMP_DIR):
    try:
        _p.mkdir(parents=True, exist_ok=True)
    except PermissionError:  # pragma: no cover
        # Running under restrictive sandbox; ignore.
        pass

# ──────────────────────────────────────────────────────────────────────────────
# App Meta Dataclass
# ──────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class AppMeta:
    """
    Immutable snapshot of build/run metadata. Safe for logging.
    """

    name: str
    version: str
    build_flavour: BuildFlavour
    environment: Environment
    platform: Platform
    instance_id: uuid.UUID

    @classmethod
    def make(cls) -> "AppMeta":
        return cls(
            name=APP_NAME,
            version=APP_VERSION,
            build_flavour=BUILD_FLAVOUR,
            environment=DEFAULT_ENV,
            platform=Platform.current(),
            instance_id=uuid.uuid4(),  # Unique per app cold-start
        )

    # Convenience helpers
    def is_debug(self) -> bool:
        return self.build_flavour.is_prerelease() or self.environment is Environment.LOCAL

    def to_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "flavour": self.build_flavour.value,
            "env": self.environment.value,
            "platform": self.platform.value,
            "instance_id": str(self.instance_id),
        }


# Module-level singleton (safe, no side-effects)
app_meta: Final[AppMeta] = AppMeta.make()

# ──────────────────────────────────────────────────────────────────────────────
# House-Keeping: Warn if running unattached to repo root.
# ──────────────────────────────────────────────────────────────────────────────
if __debug__:  # Only during development; stripped by `python -O`
    project_root = Path(__file__).resolve().parents[2]
    git_dir = project_root / ".git"
    if not git_dir.exists() and DEFAULT_ENV is Environment.LOCAL:
        import warnings

        warnings.warn(
            "Running PrismPocket outside a git-tracked directory. "
            "Some dev tooling (version resolver, pre-commit hooks) might misbehave.",
            RuntimeWarning,
            stacklevel=2,
        )
```