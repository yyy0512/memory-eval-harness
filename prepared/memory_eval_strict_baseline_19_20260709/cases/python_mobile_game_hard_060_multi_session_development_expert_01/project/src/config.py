```python
"""
src/config.py
==============

Centralised configuration management for QuestSmith.

The module exposes a lazily-loaded, immutable Config singleton that gathers
settings from environment variables, optional *.env* files, and sensible
defaults.  Settings are strongly-typed via :pyclass:`dataclasses.dataclass`
definitions to avoid stringly-typed errors throughout the codebase.

Typical usage
-------------

    from src.config import get_config

    cfg = get_config()
    if cfg.features.social_sharing:
        SocialAdapter.init(api_key=cfg.platform.social_api_key)

The module also bootstraps a production-ready logging configuration suitable
for mobile environments (Android/iOS) as well as desktop debug sessions.

Environment variables
---------------------

All variables are namespaced with ``QUESTSMITH_``.  For example:

    QUESTSMITH__DATABASE__PATH=/sdcard/Android/data/com.questsmith/files/qs.db
    QUESTSMITH__LOGGING__LEVEL=DEBUG
    QUESTSMITH__FEATURES__CRASH_REPORTING=0

Nested keys are delimited with double underscores to keep parsing trivial and
cross-shell friendly.

Optional dependency
-------------------

If *python-dotenv* is available, a ``.env`` file located in the application
root will be parsed automatically.  This is convenient for local development
or CI pipelines.

"""
from __future__ import annotations

import json
import logging
import os
import platform as _sys_platform
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Optional

try:
    # This is optional.  The application will still run fine without it.
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None  # type: ignore

# --------------------------------------------------------------------------- #
# Helper functions
# --------------------------------------------------------------------------- #


def _env(key: str, default: Optional[str] = None) -> Optional[str]:
    """Return environment variable *key* or *default* if not present."""
    namespaced = f"QUESTSMITH__{key}"
    return os.getenv(namespaced, default)


def _env_bool(key: str, default: bool = False) -> bool:
    val = _env(key)
    if val is None:
        return default
    return val.lower() in {"1", "true", "yes", "on"}


def _env_int(key: str, default: int) -> int:
    val = _env(key)
    if val is None:
        return default
    try:
        return int(val)
    except ValueError:
        logging.getLogger(__name__).warning(
            "Invalid int for %s=%r – using default %d", key, val, default
        )
        return default


def _env_json(key: str, default: Dict[str, Any] | None = None) -> Dict[str, Any]:
    val = _env(key)
    if val is None:
        return default or {}
    try:
        parsed = json.loads(val)
        if isinstance(parsed, dict):
            return parsed
        raise ValueError("top-level JSON value is not an object")
    except Exception as exc:  # pragma: no cover – best-effort warning
        logging.getLogger(__name__).warning(
            "Invalid JSON for %s=%r – %r – using default %r", key, val, exc, default
        )
        return default or {}


# --------------------------------------------------------------------------- #
# Data classes representing config sections
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Paths:
    """
    File-system locations.  All paths are resolved lazily at runtime to ensure
    they are valid on the current platform.

    Attributes
    ----------
    app_root : Path
        Root directory of the *QuestSmith* Python package.
    user_data_dir : Path
        Platform appropriate folder for user data (writable).
    database_path : Path
        SQLite database file.
    log_dir : Path
        Directory where log files will be written (if any).
    """

    app_root: Path = field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    user_data_dir: Path = field(default_factory=lambda: (Path.home() / ".questsmith"))
    database_path: Path = field(init=False)
    log_dir: Path = field(init=False)

    def __post_init__(self):
        db_default = self.user_data_dir / "questsmith.db"
        log_default = self.user_data_dir / "logs"

        object.__setattr__(
            self,
            "database_path",
            Path(_env("DATABASE__PATH", str(db_default))).expanduser(),
        )
        object.__setattr__(self, "log_dir", Path(_env("LOGGING__DIR", str(log_default))))


@dataclass(frozen=True, slots=True)
class DatabaseConfig:
    """SQLite configuration for the Repository layer."""

    path: Path
    pragma_journal_mode: str = field(
        default_factory=lambda: _env("DATABASE__JOURNAL_MODE", "WAL")
    )
    pragma_synchronous: str = field(
        default_factory=lambda: _env("DATABASE__SYNCHRONOUS", "NORMAL")
    )
    backup_on_exit: bool = field(
        default_factory=lambda: _env_bool("DATABASE__BACKUP_ON_EXIT", True)
    )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "journal_mode": self.pragma_journal_mode,
            "synchronous": self.pragma_synchronous,
            "backup_on_exit": self.backup_on_exit,
        }


@dataclass(frozen=True, slots=True)
class FeatureToggles:
    biometric_auth: bool = field(
        default_factory=lambda: _env_bool("FEATURES__BIOMETRIC_AUTH", True)
    )
    crash_reporting: bool = field(
        default_factory=lambda: _env_bool("FEATURES__CRASH_REPORTING", True)
    )
    push_notifications: bool = field(
        default_factory=lambda: _env_bool("FEATURES__PUSH_NOTIFICATIONS", True)
    )
    location_services: bool = field(
        default_factory=lambda: _env_bool("FEATURES__LOCATION_SERVICES", True)
    )
    social_sharing: bool = field(
        default_factory=lambda: _env_bool("FEATURES__SOCIAL_SHARING", True)
    )
    analytics: bool = field(
        default_factory=lambda: _env_bool("FEATURES__ANALYTICS", True)
    )
    adaptive_difficulty: bool = field(
        default_factory=lambda: _env_bool("FEATURES__ADAPTIVE_DIFFICULTY", True)
    )


@dataclass(frozen=True, slots=True)
class AnalyticsConfig:
    endpoint: str = field(
        default_factory=lambda: _env(
            "ANALYTICS__ENDPOINT", "https://api.questsmith.app/analytics"
        )
    )
    batch_size: int = field(default_factory=lambda: _env_int("ANALYTICS__BATCH_SIZE", 50))
    flush_interval_secs: int = field(
        default_factory=lambda: _env_int("ANALYTICS__FLUSH_INTERVAL_SECS", 30)
    )
    debug_mode: bool = field(
        default_factory=lambda: _env_bool("ANALYTICS__DEBUG_MODE", False)
    )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "batch_size": self.batch_size,
            "flush_interval_secs": self.flush_interval_secs,
            "debug_mode": self.debug_mode,
        }


@dataclass(frozen=True, slots=True)
class NotificationConfig:
    local_time_zone: str = field(
        default_factory=lambda: _env("NOTIFICATIONS__TIME_ZONE", "UTC")
    )
    max_daily_reminders: int = field(
        default_factory=lambda: _env_int("NOTIFICATIONS__MAX_DAILY", 20)
    )
    default_offset_mins: int = field(
        default_factory=lambda: _env_int("NOTIFICATIONS__DEFAULT_OFFSET_MINS", 5)
    )


@dataclass(frozen=True, slots=True)
class LoggingConfig:
    level: str = field(default_factory=lambda: _env("LOGGING__LEVEL", "INFO"))
    to_file: bool = field(default_factory=lambda: _env_bool("LOGGING__TO_FILE", True))
    file_name: str = field(
        default_factory=lambda: _env("LOGGING__FILE_NAME", "questsmith.log")
    )
    verbose_formatter: bool = field(
        default_factory=lambda: _env_bool("LOGGING__VERBOSE_FORMATTER", False)
    )


@dataclass(frozen=True, slots=True)
class PlatformConfig:
    """
    Read-only platform information.

    Attributes
    ----------
    name : str
        'android', 'ios', 'win', 'linux', etc.
    is_mobile : bool
        Convenience flag for mobile platforms.
    """

    name: str = field(default_factory=lambda: detect_platform())
    is_mobile: bool = field(init=False)
    social_api_key: str = field(
        default_factory=lambda: _env("PLATFORM__SOCIAL_API_KEY", "")
    )

    def __post_init__(self):
        object.__setattr__(self, "is_mobile", self.name in {"android", "ios"})


@dataclass(frozen=True, slots=True)
class Config:
    """
    Immutable root configuration object.
    """

    paths: Paths
    database: DatabaseConfig
    notifications: NotificationConfig
    analytics: AnalyticsConfig
    logging: LoggingConfig
    features: FeatureToggles
    platform: PlatformConfig
    version: str

    def to_json(self, redacted: bool = True) -> str:
        """Return a JSON representation of the configuration (useful for debugging)."""
        def _serialize(obj: Any) -> Any:
            if isinstance(obj, Path):
                return str(obj)
            if isinstance(obj, (Config, Paths, DatabaseConfig, NotificationConfig,
                                AnalyticsConfig, LoggingConfig, FeatureToggles,
                                PlatformConfig)):
                data = {
                    k: _serialize(v)
                    for k, v in obj.__dict__.items()
                    if not (redacted and "key" in k.lower())
                }
                return data
            return obj

        return json.dumps(_serialize(self), indent=2, sort_keys=True)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def detect_platform() -> str:
    """
    Attempt to detect the runtime platform in a Kivy-friendly way without
    importing heavy Kivy modules (they may trigger OpenGL init which we want to
    avoid during unit tests).
    """
    # First try Kivy's helper if available
    try:
        from kivy.utils import platform as kivy_platform  # type: ignore
    except Exception:  # pragma: no cover – fallback paths
        kivy_platform = None

    if kivy_platform:
        return kivy_platform

    # Fallback to sys.platform
    plat = sys.platform
    if plat.startswith("linux"):
        # On Android, sys.platform is 'linux', but the 'ANDROID_ARGUMENT'
        # env var is set.  Similarly, 'IOS_PLATFORM' for iOS via buildozer.
        if "ANDROID_ARGUMENT" in os.environ:
            return "android"
        if "IOS_PLATFORM" in os.environ:
            return "ios"
        return "linux"
    if plat.startswith("darwin"):
        # Could be macOS or iOS (simulator).  Treat as 'macos' for now.
        return "macos"
    if plat.startswith("win"):
        return "win"
    return plat


def _bootstrap_logging(cfg: LoggingConfig, paths: Paths) -> None:
    """
    Configure the root logger exactly once.  Subsequent calls are no-ops unless
    the logging subsystem has been reset elsewhere.
    """
    if logging.getLogger().handlers:
        return  # Already configured

    level = getattr(logging, cfg.level.upper(), logging.INFO)

    formatter = logging.Formatter(
        fmt=(
            "%(asctime)s | %(levelname)-8s | %(name)s | "
            "%(funcName)s:%(lineno)d | %(message)s"
            if cfg.verbose_formatter
            else "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
        )
    )

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    handlers[0].setFormatter(formatter)

    if cfg.to_file:
        try:
            paths.log_dir.mkdir(parents=True, exist_ok=True)
            file_path = paths.log_dir / cfg.file_name
            file_handler = logging.FileHandler(file_path, encoding="utf-8")
            file_handler.setFormatter(formatter)
            handlers.append(file_handler)
        except Exception as exc:  # pragma: no cover
            # Fallback to console-only logging
            logging.getLogger(__name__).warning(
                "Could not init file logging: %s – continuing with STDOUT only.", exc
            )

    logging.basicConfig(level=level, handlers=handlers)
    logging.getLogger(__name__).debug("Logging initialised with level=%s", cfg.level)


@lru_cache(maxsize=1)
def get_config() -> Config:
    """
    Return the cached Config singleton, loading from env/defaults on first call.
    """
    if load_dotenv:
        # Load .env file if present – this doesn't overwrite existing env vars.
        env_path = Path(".env")
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=False)

    paths = Paths()
    database = DatabaseConfig(path=paths.database_path)
    notifications = NotificationConfig()
    analytics = AnalyticsConfig()
    logging_cfg = LoggingConfig()
    features = FeatureToggles()
    platform_cfg = PlatformConfig()

    # Attempt to read package version via importlib.metadata (Python ≥3.8).
    try:
        import importlib.metadata as _metadata  # pytype: disable=import-error
        version = _metadata.version("questsmith")
    except Exception:
        # Fallback to git-style '0.0.0.dev' marker
        version = _env("APP__VERSION", "0.0.0.dev")

    cfg = Config(
        paths=paths,
        database=database,
        notifications=notifications,
        analytics=analytics,
        logging=logging_cfg,
        features=features,
        platform=platform_cfg,
        version=version,
    )

    # Side-effect: configure logging immediately so that subsequent modules
    # importing this config have a logger ready to go.
    _bootstrap_logging(cfg.logging, cfg.paths)

    logging.getLogger(__name__).info(
        "QuestSmith v%s starting on %s", cfg.version, cfg.platform.name
    )
    logging.getLogger(__name__).debug("Configuration loaded:\n%s", cfg.to_json())

    return cfg
```