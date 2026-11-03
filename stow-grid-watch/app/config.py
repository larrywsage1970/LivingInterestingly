"""Settings and location config. Everything comes from env vars or locations.json."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Link:
    label: str
    url: str
    verified: bool


@dataclass(frozen=True)
class Location:
    id: str
    name: str
    county: str
    state: str
    fips_state: str
    fips_county: str
    lat: float
    lon: float
    utility: str
    grid_operator: str
    forecast_low_amber_f: float
    links: tuple[Link, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class Settings:
    user_agent: str
    db_path: Path
    locations_file: Path
    poll: bool


def get_settings() -> Settings:
    return Settings(
        user_agent=os.environ.get("SGW_USER_AGENT", "GRID/0.1 (contact: unset)"),
        db_path=Path(os.environ.get("SGW_DB_PATH", BASE_DIR / "data" / "sgw.sqlite3")),
        locations_file=Path(os.environ.get("SGW_LOCATIONS_FILE", BASE_DIR / "locations.json")),
        poll=os.environ.get("SGW_POLL", "1") == "1",
    )


def load_locations(path: Path) -> tuple[str, dict[str, Location]]:
    raw = json.loads(Path(path).read_text())
    locs: dict[str, Location] = {}
    for item in raw["locations"]:
        links = tuple(Link(**l) for l in item.pop("links", []))
        loc = Location(**item, links=links)
        locs[loc.id] = loc
    default = raw.get("default") or next(iter(locs))
    return default, locs
