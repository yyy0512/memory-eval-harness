from __future__ import annotations

"""
constants.py – Centralised constant definitions for QuestSmith.

This module is intentionally light-weight and free of business logic; it aggregates
static values, enumerations, and configuration helpers referenced across the codebase.
"""

import os
import sys
from dataclasses import dataclass
from enum import Enum, IntEnum, unique
from pathlib import Path
from typing import Any, Final, Mapping

# ────────────────────────────────────────────────────────────────────────────────
# Application metadata
# ────────────────────────────────────────────────────────────────────────────────
APP_NAME: Final[str] = "QuestSmith"
PACKAGE_NAME: Final[str] = "com.questsmith.game"
VERSION: Final[str] = "1.4.0"
BUILD_NUMBER: Final[int] = 57

# ────────────────────────────────────────────────────────────────────────────────
# Directory layout helpers
# ────────────────────────────────────────────────────────────────────────────────
if hasattr(sys, "_MEIPASS"):  # PyInstaller bundle
    _BASE_DIR = Path(sys._MEIPASS)
else:
    _BASE_DIR = Path(__file__).resolve().parent.parent  # project root

USER_DATA_DIR: Final[Path] = Path(
    os.getenv("QUESTSMITH_USER_DATA_DIR", (Path.home() / f".{APP_NAME.lower()}"))
)

DB_FILE: Final[Path] = USER_DATA_DIR / "questsmith.db"
LOG_DIR: Final[Path] = USER_DATA_DIR / "logs"
CRASH_DUMP_DIR: Final[Path] = USER_DATA_DIR / "crash"

# Ensure essential paths exist early in the app lifecycle.
for _directory in (USER_DATA_DIR, LOG_DIR, CRASH_DUMP_DIR):
    try:
        _directory.mkdir(parents=True, exist_ok=True)
    except (OSError, PermissionError) as exc:  # pragma: no cover
        raise RuntimeError(f"Unable to create directory '{_directory}': {exc}") from exc

# ────────────────────────────────────────────────────────────────────────────────
# Feature flags / toggles
# ────────────────────────────────────────────────────────────────────────────────
def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


BIOMETRIC_AUTH_ENABLED: Final[bool] = _env_flag("QUESTSMITH_BIOMETRIC_AUTH", True)
CRASH_REPORTING_ENABLED: Final[bool] = _env_flag("QUESTSMITH_CRASH_REPORTING", True)
PUSH_NOTIFICATIONS_ENABLED: Final[bool] = _env_flag("QUESTSMITH_PUSH_NOTIFICATIONS", True)
LOCATION_SERVICES_ENABLED: Final[bool] = _env_flag("QUESTSMITH_LOCATION_SERVICES", True)
SOCIAL_SHARING_ENABLED: Final[bool] = _env_flag("QUESTSMITH_SOCIAL_SHARING", True)

# ────────────────────────────────────────────────────────────────────────────────
# Observer / Event-bus topics
# ────────────────────────────────────────────────────────────────────────────────
@unique
class BusEvent(str, Enum):
    """Canonical identifiers for the Observer Pattern event-bus."""
    QUEST_CREATED = "quest/created"
    QUEST_UPDATED = "quest/updated"
    QUEST_COMPLETED = "quest/completed"
    QUEST_EXPIRED = "quest/expired"
    USER_LEVEL_UP = "user/level_up"
    INVENTORY_CHANGED = "inventory/changed"
    CURRENCY_BALANCE_CHANGED = "currency/balance_changed"
    NOTIFICATION_SCHEDULED = "notification/scheduled"
    NOTIFICATION_DISMISSED = "notification/dismissed"


# ────────────────────────────────────────────────────────────────────────────────
# SQLite repository table names
# ────────────────────────────────────────────────────────────────────────────────
@unique
class TableName(str, Enum):
    QUESTS = "quests"
    REWARDS = "rewards"
    USER_PROFILE = "user_profile"
    SETTINGS = "settings"
    ANALYTICS_QUEUE = "analytics_queue"
    CRASH_LOG = "crash_log"


# ────────────────────────────────────────────────────────────────────────────────
# Analytics constants
# ────────────────────────────────────────────────────────────────────────────────
@unique
class AnalyticsEvent(str, Enum):
    APP_OPEN = "app_open"
    APP_CLOSE = "app_close"
    QUEST_COMPLETED = "quest_completed"
    QUEST_FORFEITED = "quest_forfeited"
    ITEM_CRAFTED = "item_crafted"
    PURCHASE_MADE = "purchase_made"
    SHARE_TRIGGERED = "share_triggered"
    AUTH_BIOMETRIC_SUCCESS = "auth_biometric_success"
    AUTH_BIOMETRIC_FAIL = "auth_biometric_fail"


ANALYTICS_STATIC_PROPS: Final[Mapping[AnalyticsEvent, Mapping[str, Any]]] = {
    AnalyticsEvent.APP_OPEN: {"launch_type": "cold"},
    AnalyticsEvent.APP_CLOSE: {},
    AnalyticsEvent.QUEST_COMPLETED: {"reward_given": True},
}

# ────────────────────────────────────────────────────────────────────────────────
# UI / design-token constants
# ────────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Color:
    """RGBA container with normalised floats (0–1)."""
    r: float
    g: float
    b: float
    a: float = 1.0

    def as_tuple(self) -> tuple[float, float, float, float]:
        return (self.r, self.g, self.b, self.a)


class Palette:
    """Consistent colour palette across the application."""
    PRIMARY = Color(0.13, 0.59, 0.95)
    PRIMARY_DARK = Color(0.10, 0.47, 0.78)
    ACCENT = Color(1.00, 0.76, 0.03)
    BACKGROUND = Color(0.11, 0.12, 0.16)
    SURFACE = Color(0.18, 0.19, 0.24)
    TEXT_PRIMARY = Color(0.95, 0.96, 0.97)
    TEXT_SECONDARY = Color(0.70, 0.71, 0.73)
    ERROR = Color(0.91, 0.29, 0.23)
    SUCCESS = Color(0.18, 0.80, 0.44)

# ────────────────────────────────────────────────────────────────────────────────
# Adaptive difficulty constants
# ────────────────────────────────────────────────────────────────────────────────
class DifficultyTier(IntEnum):
    EASY = 1
    NORMAL = 2
    HARD = 3
    HEROIC = 4
    LEGENDARY = 5


DIFFICULTY_XP_MULTIPLIER: Final[Mapping[DifficultyTier, float]] = {
    DifficultyTier.EASY: 0.75,
    DifficultyTier.NORMAL: 1.0,
    DifficultyTier.HARD: 1.25,
    DifficultyTier.HEROIC: 1.55,
    DifficultyTier.LEGENDARY: 2.0,
}

# ────────────────────────────────────────────────────────────────────────────────
# In-app purchase (IAP) identifiers
# ────────────────────────────────────────────────────────────────────────────────
@unique
class IAPProduct(str, Enum):
    COIN_PACK_SMALL = "coin_pack_small"
    COIN_PACK_MEDIUM = "coin_pack_medium"
    COIN_PACK_LARGE = "coin_pack_large"
    SEASON_PASS = "season_pass"
    COSMETIC_BUNDLE = "cosmetic_bundle"

# ────────────────────────────────────────────────────────────────────────────────
# Build-time / environment info
# ────────────────────────────────────────────────────────────────────────────────
@unique
class Environment(str, Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


def current_environment(default: Environment = Environment.PRODUCTION) -> Environment:
    raw = os.getenv("QUESTSMITH_ENV", default.value).lower()
    try:
        return Environment(raw)
    except ValueError:
        return default


ENVIRONMENT: Final[Environment] = current_environment()

# ────────────────────────────────────────────────────────────────────────────────
# Security-sensitive keys (injected via env variables)
# ────────────────────────────────────────────────────────────────────────────────
def _get_secret(name: str, mandatory: bool = False) -> str | None:
    value = os.getenv(name)
    if mandatory and not value:
        raise RuntimeError(
            f"Required secret '{name}' not found in environment. "
            "Consult deployment guide for proper configuration."
        )
    return value


CRASH_REPORT_API_KEY: Final[str | None] = _get_secret(
    "QUESTSMITH_CRASH_API_KEY", CRASH_REPORTING_ENABLED
)
PUSH_NOTIFICATION_SENDER_ID: Final[str | None] = _get_secret("QUESTSMITH_GCM_SENDER_ID")
FACEBOOK_APP_ID: Final[str | None] = _get_secret("QUESTSMITH_FB_APP_ID")

# ────────────────────────────────────────────────────────────────────────────────
# Gameplay constants
# ────────────────────────────────────────────────────────────────────────────────
MAX_DAILY_QUESTS_FREE_TIER: Final[int] = 12
MAX_DAILY_QUESTS_PREMIUM_TIER: Final[int] = 50

BASE_XP_PER_QUEST: Final[int] = 25
QUEST_EXPIRY_HOURS: Final[int] = 48

# ────────────────────────────────────────────────────────────────────────────────
# Logging configuration
# ────────────────────────────────────────────────────────────────────────────────
DEFAULT_LOG_LEVEL: Final[str] = os.getenv("QUESTSMITH_LOG_LEVEL", "INFO")
FILE_LOG_PATTERN: Final[str] = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"

# ────────────────────────────────────────────────────────────────────────────────
# Public export list
# ────────────────────────────────────────────────────────────────────────────────
__all__ = [
    # Metadata
    "APP_NAME",
    "PACKAGE_NAME",
    "VERSION",
    "BUILD_NUMBER",
    # Paths
    "USER_DATA_DIR",
    "DB_FILE",
    "LOG_DIR",
    "CRASH_DUMP_DIR",
    # Feature flags
    "BIOMETRIC_AUTH_ENABLED",
    "CRASH_REPORTING_ENABLED",
    "PUSH_NOTIFICATIONS_ENABLED",
    "LOCATION_SERVICES_ENABLED",
    "SOCIAL_SHARING_ENABLED",
    # Enums
    "BusEvent",
    "TableName",
    "AnalyticsEvent",
    "DifficultyTier",
    "IAPProduct",
    "Environment",
    # UI
    "Color",
    "Palette",
    # Analytics
    "ANALYTICS_STATIC_PROPS",
    # Difficulty
    "DIFFICULTY_XP_MULTIPLIER",
    # Environment
    "ENVIRONMENT",
    # Secrets
    "CRASH_REPORT_API_KEY",
    "PUSH_NOTIFICATION_SENDER_ID",
    "FACEBOOK_APP_ID",
    # Gameplay
    "MAX_DAILY_QUESTS_FREE_TIER",
    "MAX_DAILY_QUESTS_PREMIUM_TIER",
    "BASE_XP_PER_QUEST",
    "QUEST_EXPIRY_HOURS",
    # Logging
    "DEFAULT_LOG_LEVEL",
    "FILE_LOG_PATTERN",
]