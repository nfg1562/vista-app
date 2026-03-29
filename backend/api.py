import asyncio
import csv
import io
import json
import logging
import math
import os
import time
import zipfile
from datetime import datetime
from typing import Dict, List, Optional, Sequence

import numpy as np
from fastapi import (
    Body,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from auth import (
    admin_enabled,
    auth_enabled,
    authenticate_password,
    authorize_websocket,
    create_access_token,
    decode_access_token,
    get_required_role_for_http,
    require_http_auth,
    viewer_enabled,
)
from match_state import MatchClockState, build_match_state
from analytics.normalize import normalize_frames_to_dfs
from analytics.pipeline import build_analytics_snapshot
from analytics.recommendations import (
    generate_tactical_recommendations,
    suggest_pressing_adaptations_df,
)
from analytics.substitutions import compute_sub_windows
from frame_repository import FrameRepository
from models import MatchMeta
from reco_engine import ensure_recos_up_to_date
from reco_repository import InMemoryRecoRepository, SQLiteRecoRepository
from sim.generator import SimGenerator, SimGeneratorConfig, build_sim_team_config
from sim.hybrid_presets import load_hybrid_preset
from sim.publisher import SimPublisher
from store import InMemoryStore
from ws import WSManager


class SimConfig(BaseModel):
    durationMinutes: int = Field(gt=0, default=90)
    emitFps: int = Field(gt=0, default=1)


class MatchSettingsPayload(BaseModel):
    added_time_first_half: int = Field(ge=0, default=0)
    added_time_second_half: int = Field(ge=0, default=0)


class RosterEntry(BaseModel):
    numero: int
    nom: str


class MatchConfigPayload(BaseModel):
    title: str
    competition: str
    fixtureId: str
    homeName: str
    awayName: str
    rosterHome: Sequence[RosterEntry]
    rosterAway: Sequence[RosterEntry]
    benchHome: Sequence[RosterEntry]
    benchAway: Sequence[RosterEntry]


class ControlEventPayload(BaseModel):
    type: str
    minute: int = Field(ge=0)
    team: Optional[str] = None
    player_id: Optional[str] = None
    player_out_id: Optional[str] = None
    player_in_id: Optional[str] = None


class LoginPayload(BaseModel):
    password: str = Field(min_length=1)


class MatchContext:
    def __init__(self, match_id: str):
        self.match_id = match_id
        self.ws_manager = WSManager()
        self.reco_repo = reco_repo
        self.reco_lock = asyncio.Lock()
        self.settings = MatchSettingsPayload()
        self.reset_simulation()
        self.match_info: Dict[str, str] = {}
        self.rosters: Dict[str, Sequence[RosterEntry]] = {}
        self.match_meta: Optional[MatchMeta] = None
        self.is_imported: bool = False

    def reset_simulation(self) -> None:
        self.store = InMemoryStore()
        self.clock = MatchClockState()
        self.clock.init_idle()
        self.generator: Optional[SimGenerator] = None
        self.publisher: Optional[SimPublisher] = None
        self.sim_config: Optional[SimConfig] = None
        self.config_payload: Optional[MatchConfigPayload] = None
        self.control_events: List[Dict[str, Optional[str]]] = []
        self.is_imported = False
        self.reco_repo.clear_match(self.match_id)

    def reset_runtime(self) -> None:
        self.store = InMemoryStore()
        self.clock = MatchClockState()
        self.clock.init_idle()
        self.generator = None
        self.publisher = None
        self.sim_config = None
        self.control_events = []
        self.is_imported = False
        self.reco_repo.clear_match(self.match_id)

    def apply_match_config(self, payload: MatchConfigPayload) -> MatchMeta:
        self.config_payload = payload
        self.match_info = {
            "title": payload.title,
            "competition": payload.competition,
            "fixtureId": payload.fixtureId,
            "home": payload.homeName,
            "away": payload.awayName,
        }
        self.rosters = {
            "home": payload.rosterHome,
            "away": payload.rosterAway,
            "bench_home": payload.benchHome,
            "bench_away": payload.benchAway,
        }
        fixture_value = (
            int(payload.fixtureId)
            if payload.fixtureId.isdigit()
            else abs(hash(payload.fixtureId)) % 10000
        )
        meta = MatchMeta(
            meta=True,
            fixtureId=fixture_value,
            league={"id": 0, "name": payload.competition},
            home={"id": 1, "name": payload.homeName},
            away={"id": 2, "name": payload.awayName},
        )
        self.match_meta = meta
        self.store.set_meta(meta)
        return meta

def _build_reco_repo():
    repo_type = os.getenv("RECO_REPO", "sqlite").strip().lower()
    if repo_type == "memory":
        return InMemoryRecoRepository()
    return SQLiteRecoRepository()


def _build_cors_origins() -> List[str]:
    raw = os.getenv("VISTA_CORS_ORIGINS", "").strip()
    if not raw:
        return ["http://localhost:3000", "http://127.0.0.1:3000"]
    if raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


matches: Dict[str, MatchContext] = {}
frame_repo = FrameRepository()
reco_repo = _build_reco_repo()
cors_origins = _build_cors_origins()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger = logging.getLogger("backend.api")


@app.middleware("http")
async def enforce_http_auth(request: Request, call_next):
    required_role = get_required_role_for_http(request.method, request.url.path)
    if required_role is not None:
        try:
            request.state.auth = require_http_auth(request, required_role)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


def to_jsonable(value):
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    if isinstance(value, tuple):
        return [to_jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return to_jsonable(value.tolist())
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        num = float(value)
        return num if math.isfinite(num) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def _coerce_int(value: Optional[str | int | float], default: Optional[int] = 0) -> Optional[int]:
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Optional[str | int | float], default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_bool(value: Optional[str | int | bool]) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "oui")
    return bool(value)


def _parse_csv_rows(text: str) -> List[dict]:
    reader = csv.DictReader(io.StringIO(text))
    rows: List[dict] = []
    for row in reader:
        if not row:
            continue
        rows.append({k: v for k, v in row.items() if k})
    return rows


def _prepare_import_rows(rows: Sequence[dict]) -> List[dict]:
    prepared: List[dict] = []
    for row in rows:
        if not row or not any(v not in (None, "") for v in row.values()):
            continue
        record = {k: v for k, v in row.items() if v not in ("", None)}
        time_val = _coerce_int(
            record.get("time")
            or record.get("time_sec")
            or record.get("timestamp")
            or record.get("ts"),
            default=None,
        )
        minute_val = _coerce_int(record.get("minute"), default=None)
        if minute_val is None:
            minute_val = (time_val or 0) // 60
        if time_val is None:
            time_val = minute_val * 60
        record["time"] = time_val or 0
        record["minute"] = minute_val
        prepared.append(record)
    return prepared


def _infer_kind_from_columns(sample: dict) -> Optional[str]:
    if not sample:
        return None
    cols = {key.lower() for key in sample.keys()}
    if "event_type" in cols or "eventtype" in cols:
        return "evt"
    if "speed" in cols or "fatigue" in cols:
        return "phy"
    if "role" in cols:
        return "pos"
    return None


def _normalize_import_payload(
    positions: Sequence[dict],
    physical: Sequence[dict],
    events: Sequence[dict],
) -> tuple[List[dict], List[dict], List[dict]]:
    pos_rows = _prepare_import_rows(positions)
    phy_rows = _prepare_import_rows(physical)
    evt_rows = _prepare_import_rows(events)
    pos_df, evt_df, phy_df, _ = normalize_frames_to_dfs(pos_rows, phy_rows, evt_rows, stats=None)
    pos_records = pos_df.to_dict(orient="records")
    evt_records = evt_df.to_dict(orient="records")
    phy_records = phy_df.to_dict(orient="records")
    for record in pos_records:
        record["time"] = _coerce_int(record.get("time"), default=0) or 0
        record["minute"] = _coerce_int(record.get("minute"), default=record["time"] // 60) or 0
        record["x"] = _coerce_float(record.get("x"), default=50.0)
        record["y"] = _coerce_float(record.get("y"), default=25.0)
    for record in phy_records:
        record["time"] = _coerce_int(record.get("time"), default=0) or 0
        record["minute"] = _coerce_int(record.get("minute"), default=record["time"] // 60) or 0
        record["speed"] = _coerce_float(record.get("speed"), default=0.0)
        record["fatigue"] = _coerce_float(record.get("fatigue"), default=0.0)
    for record in evt_records:
        record["time"] = _coerce_int(record.get("time"), default=0) or 0
        record["minute"] = _coerce_int(record.get("minute"), default=record["time"] // 60) or 0
        record["x"] = _coerce_float(record.get("x"), default=50.0)
        record["y"] = _coerce_float(record.get("y"), default=25.0)
        record["momentum"] = _coerce_float(record.get("momentum"), default=0.5)
        record["xG"] = _coerce_float(record.get("xG"), default=0.0)
        record["success"] = _coerce_bool(record.get("success", False))
    return pos_records, evt_records, phy_records


def _match_bounds(settings: MatchSettingsPayload) -> tuple[int, int]:
    added_first = max(0, int(settings.added_time_first_half))
    added_second = max(0, int(settings.added_time_second_half))
    end_first_half = 45 + added_first
    end_second_half = 90 + added_second
    if end_first_half > end_second_half:
        end_first_half = end_second_half
    return end_first_half, end_second_half


def _resolve_target_minute(ctx: MatchContext, match_id: str, minute: Optional[int]) -> int:
    if minute is not None:
        target_minute = max(0, int(minute))
        _, end_second_half = _match_bounds(ctx.settings)
        return min(target_minute, end_second_half)
    if ctx.is_imported or frame_repo.has_frames(match_id):
        _, available_max = frame_repo.get_available_minutes(match_id)
        if available_max is not None:
            _, end_second_half = _match_bounds(ctx.settings)
            return min(int(available_max), end_second_half)
    last_time = ctx.store.get_last_time()
    if last_time > 0:
        target_minute = last_time // 60
    else:
        target_minute = max(0, ctx.clock.get_live_time() // 60)
    _, end_second_half = _match_bounds(ctx.settings)
    return min(target_minute, end_second_half)


def _load_frames_up_to_minute(
    ctx: MatchContext,
    match_id: str,
    target_minute: int,
) -> tuple[List, List, List]:
    use_db = ctx.is_imported or frame_repo.has_frames(match_id)
    available_min = None
    available_max = None
    if use_db:
        available_min, available_max = frame_repo.get_available_minutes(match_id)
        if available_min is None or available_max is None:
            use_db = False
    if use_db and available_min is not None and available_max is not None:
        if target_minute < available_min:
            return [], [], []
        target_minute = min(target_minute, available_max)
        return (
            frame_repo.get_frames_up_to_minute(match_id, "pos", target_minute),
            frame_repo.get_frames_up_to_minute(match_id, "evt", target_minute),
            frame_repo.get_frames_up_to_minute(match_id, "phy", target_minute),
        )
    pos_frames = [frame for frame in ctx.store.all_positions() if frame.minute <= target_minute]
    evt_frames = [frame for frame in ctx.store.all_events() if frame.minute <= target_minute]
    phy_frames = [frame for frame in ctx.store.all_physical() if frame.minute <= target_minute]
    return pos_frames, evt_frames, phy_frames


def _substitution_context(
    control_events: List[Dict[str, Optional[str]]],
    end_first_half: int,
    end_second_half: int,
) -> tuple[int, int, List[str]]:
    subs = [
        evt for evt in control_events if str(evt.get("type", "")).upper() == "SUBSTITUTION"
    ]
    total_subs_done = len(subs)
    sub_windows_used = compute_sub_windows(subs, end_first_half, end_second_half)
    replaced_players = [
        evt.get("player_out_id") for evt in subs if evt.get("player_out_id")
    ]
    return total_subs_done, sub_windows_used, replaced_players


def _compute_recos(
    ctx: MatchContext,
    match_id: str,
    target_minute: int,
) -> Dict[str, object]:
    end_first_half, end_second_half = _match_bounds(ctx.settings)
    target_minute = min(int(target_minute), end_second_half)
    pos_frames, evt_frames, phy_frames = _load_frames_up_to_minute(
        ctx, match_id, target_minute
    )
    pos_df, evt_df, phy_df, stats_df = normalize_frames_to_dfs(
        pos_frames, phy_frames, evt_frames, stats=None
    )
    total_subs_done, sub_windows_used, replaced_players = _substitution_context(
        ctx.control_events, end_first_half, end_second_half
    )
    return ensure_recos_up_to_date(
        match_id=match_id,
        current_minute=target_minute,
        positions_df=pos_df,
        physical_df=phy_df,
        events_df=evt_df,
        stats_df=stats_df,
        repo=ctx.reco_repo,
        tactical_fn=generate_tactical_recommendations,
        pressing_fn=suggest_pressing_adaptations_df,
        total_subs_done=total_subs_done,
        sub_windows_used=sub_windows_used,
        replaced_players=replaced_players,
        halftime_minute=end_first_half,
        end_second_half=end_second_half,
        team_pressing="Team_A",
        clock_status=ctx.clock.status,
    )


async def _compute_recos_async(
    ctx: MatchContext,
    match_id: str,
    target_minute: int,
) -> Dict[str, object]:
    async with ctx.reco_lock:
        return _compute_recos(ctx, match_id, target_minute)


def get_context(match_id: str) -> MatchContext:
    if match_id not in matches:
        matches[match_id] = MatchContext(match_id)
    return matches[match_id]


def _build_meta(match_id: str) -> MatchMeta:
    return MatchMeta(
        meta=True,
        fixtureId=abs(hash(match_id)) % 10000,
        league={"id": 0, "name": "Simulation League"},
        home={"id": 1, "name": "Team_A"},
        away={"id": 2, "name": "Team_B"},
    )


async def _broadcast_meta(match_id: str, ctx: MatchContext, meta: MatchMeta) -> None:
    await ctx.ws_manager.broadcast(match_id, json.dumps({"type": "meta", "payload": meta.dict()}))


def _build_initials(label: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in str(label or ""))
    parts = [part for part in cleaned.split() if part]
    return "".join(part[0].upper() for part in parts[:2])


def _serialize_roster_entries(entries: Optional[Sequence[RosterEntry]]) -> List[dict]:
    serialized: List[dict] = []
    for entry in entries or []:
        if isinstance(entry, dict):
            numero = entry.get("numero", "")
            nom = entry.get("nom", "") or ""
        else:
            numero = getattr(entry, "numero", "")
            nom = getattr(entry, "nom", "") or ""
        serialized.append(
            {
                "numero": numero,
                "nom": nom,
            }
        )
    return serialized


def _build_public_match_config(ctx: MatchContext) -> dict:
    end_first_half, end_second_half = _match_bounds(ctx.settings)
    info = ctx.match_info or {}
    home = str(info.get("home") or "Team_A")
    away = str(info.get("away") or "Team_B")
    return {
        "configured": bool(ctx.config_payload or ctx.match_info),
        "matchInfo": {
            "title": str(info.get("title") or "Match à analyser"),
            "competition": str(info.get("competition") or "Competition"),
            "fixture_id": str(info.get("fixtureId") or ""),
            "home": home,
            "away": away,
            "home_initials": _build_initials(home),
            "away_initials": _build_initials(away),
            "matchLength": end_second_half,
            "halftime": end_first_half,
        },
        "roster": {
            "homeStarting": _serialize_roster_entries(ctx.rosters.get("home")),
            "awayStarting": _serialize_roster_entries(ctx.rosters.get("away")),
            "homeBench": _serialize_roster_entries(ctx.rosters.get("bench_home")),
            "awayBench": _serialize_roster_entries(ctx.rosters.get("bench_away")),
        },
    }


@app.get("/auth/mode")
async def get_auth_mode():
    return {
        "enabled": auth_enabled(),
        "admin_enabled": admin_enabled(),
        "viewer_enabled": viewer_enabled(),
    }


@app.post("/auth/login")
async def login(payload: LoginPayload):
    role = authenticate_password(payload.password)
    token = create_access_token(role)
    session = decode_access_token(token)
    return {
        "token": token,
        "role": role,
        "expires_at": session["exp"],
    }


@app.get("/health")
async def healthcheck():
    return {"status": "ok", "auth_enabled": auth_enabled()}


@app.post("/matches/{match_id}/sim/init")
async def init_sim(match_id: str, payload: Optional[SimConfig] = None):
    if payload is None:
        payload = SimConfig()
    ctx = get_context(match_id)
    if ctx.publisher:
        await ctx.publisher.stop()
    ctx.reset_simulation()
    ctx.sim_config = payload
    ctx.generator = SimGenerator(
        SimGeneratorConfig(duration_minutes=payload.durationMinutes, emit_fps=payload.emitFps),
        teams=build_sim_team_config(ctx.rosters),
    )
    async def _reco_tick(current_minute: int) -> None:
        await _compute_recos_async(ctx, match_id, current_minute)
    ctx.publisher = SimPublisher(
        match_id=match_id,
        store=ctx.store,
        clock=ctx.clock,
        ws_broadcast=ctx.ws_manager.broadcast,
        generator=ctx.generator,
        emit_fps=payload.emitFps,
        on_reco_tick=_reco_tick,
    )
    meta = ctx.match_meta or _build_meta(match_id)
    if meta:
        ctx.store.set_meta(meta)
        await _broadcast_meta(match_id, ctx, meta)
    return {
        "status": ctx.clock.status,
        "liveTimeSec": ctx.clock.liveTimeSec,
        "lastStoredSec": ctx.store.get_last_time(),
    }


@app.post("/matches/{match_id}/sim/start")
async def start_sim(match_id: str):
    ctx = get_context(match_id)
    if not ctx.publisher or not ctx.sim_config:
        await init_sim(match_id)  # default initialization
        ctx = get_context(match_id)
    logger.info("sim/start match_id=%s clock_id=%s", match_id, id(ctx.clock))
    ctx.clock.start()
    await ctx.publisher.start()
    return {
        "status": ctx.clock.status,
        "liveTimeSec": ctx.clock.liveTimeSec,
        "lastStoredSec": ctx.store.get_last_time(),
    }


@app.post("/matches/{match_id}/config")
async def configure_match(match_id: str, payload: MatchConfigPayload):
    ctx = get_context(match_id)
    meta = ctx.apply_match_config(payload)
    await _broadcast_meta(match_id, ctx, meta)
    return {"match_info": ctx.match_info, "rosters": ctx.rosters, "meta": meta.dict()}


@app.get("/matches/{match_id}/config")
async def get_match_config(match_id: str):
    ctx = get_context(match_id)
    return _build_public_match_config(ctx)


@app.post("/matches/{match_id}/preset/load")
async def load_match_preset(match_id: str):
    ctx = get_context(match_id)
    preset = load_hybrid_preset(ctx.match_info, ctx.rosters)
    if not preset:
        raise HTTPException(status_code=404, detail="No preset available for this match")

    if ctx.publisher:
        await ctx.publisher.stop()

    ctx.reset_runtime()
    frame_repo.clear_match(match_id)

    positions = list(preset.get("positions", []) or [])
    physical = list(preset.get("physical", []) or [])
    events = list(preset.get("events", []) or [])

    pos_count = frame_repo.insert_frames(match_id, "pos", positions)
    evt_count = frame_repo.insert_frames(match_id, "evt", events)
    phy_count = frame_repo.insert_frames(match_id, "phy", physical)
    ctx.is_imported = True

    max_minute = int(preset.get("max_minute", 95))
    ctx.clock.liveTimeSec = 0
    ctx.clock.status = "paused"
    ctx.clock.anchorWallTsMs = None
    ctx.clock.anchorMatchSec = ctx.clock.liveTimeSec

    if ctx.match_meta:
        ctx.store.set_meta(ctx.match_meta)
        await _broadcast_meta(match_id, ctx, ctx.match_meta)

    await _compute_recos_async(ctx, match_id, max_minute)
    return {
        "loaded": True,
        "preset_id": preset.get("preset_id"),
        "counts": {"positions": pos_count, "events": evt_count, "physical": phy_count},
        "available_minutes": {"min": 0, "max": max_minute},
        "status": ctx.clock.status,
        "liveTimeSec": ctx.clock.liveTimeSec,
        "data_mode": "static_import",
    }


@app.post("/matches/{match_id}/settings")
async def update_match_settings(match_id: str, payload: MatchSettingsPayload):
    ctx = get_context(match_id)
    ctx.settings = payload
    end_first_half, end_second_half = _match_bounds(ctx.settings)
    return {
        "settings": ctx.settings.model_dump(),
        "bounds": {"end_first_half": end_first_half, "end_second_half": end_second_half},
    }


@app.post("/matches/{match_id}/import")
async def import_match(
    match_id: str,
    file: Optional[UploadFile] = File(None),
    payload: Optional[dict] = Body(None),
    kind: Optional[str] = Query(None),
):
    ctx = get_context(match_id)
    positions: List[dict] = []
    events: List[dict] = []
    physical: List[dict] = []

    if file is not None:
        raw = await file.read()
        filename = (file.filename or "").lower()
        if filename.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for name in zf.namelist():
                    lower = name.lower()
                    if lower.endswith("positions.csv"):
                        positions.extend(_parse_csv_rows(zf.read(name).decode("utf-8")))
                    elif lower.endswith("events.csv"):
                        events.extend(_parse_csv_rows(zf.read(name).decode("utf-8")))
                    elif lower.endswith("physical.csv"):
                        physical.extend(_parse_csv_rows(zf.read(name).decode("utf-8")))
        elif filename.endswith(".json"):
            payload = json.loads(raw.decode("utf-8"))
        elif filename.endswith(".csv"):
            rows = _parse_csv_rows(raw.decode("utf-8"))
            inferred = kind or _infer_kind_from_columns(rows[0] if rows else {})
            if inferred == "evt":
                events = rows
            elif inferred == "phy":
                physical = rows
            else:
                positions = rows
        else:
            raise HTTPException(status_code=400, detail="Unsupported import format")

    if payload is not None:
        if isinstance(payload, dict):
            frames = payload.get("frames") if "frames" in payload else payload
            positions.extend(frames.get("positions", []) or frames.get("pos", []))
            events.extend(frames.get("events", []) or frames.get("evt", []))
            physical.extend(frames.get("physical", []) or frames.get("phy", []))
        elif isinstance(payload, list):
            for item in payload:
                item_kind = str(item.get("kind") or item.get("type") or "").lower()
                if item_kind in ("evt", "event", "events"):
                    events.append(item)
                elif item_kind in ("phy", "physical"):
                    physical.append(item)
                else:
                    positions.append(item)

    if not positions and not events and not physical:
        raise HTTPException(status_code=400, detail="No frames found in import payload")

    pos_records, evt_records, phy_records = _normalize_import_payload(
        positions=positions,
        physical=physical,
        events=events,
    )
    frame_repo.clear_match(match_id)
    ctx.reco_repo.clear_match(match_id)
    pos_count = frame_repo.insert_frames(match_id, "pos", pos_records)
    evt_count = frame_repo.insert_frames(match_id, "evt", evt_records)
    phy_count = frame_repo.insert_frames(match_id, "phy", phy_records)
    ctx.is_imported = True
    min_minute, max_minute = frame_repo.get_available_minutes(match_id)
    if max_minute is not None:
        await _compute_recos_async(ctx, match_id, max_minute)
    return {
        "imported": True,
        "counts": {"positions": pos_count, "events": evt_count, "physical": phy_count},
        "available_minutes": {"min": min_minute, "max": max_minute},
    }


@app.post("/matches/{match_id}/events")
async def add_control_event(match_id: str, payload: ControlEventPayload):
    ctx = get_context(match_id)
    ctx.control_events.append(payload.model_dump())
    return {"count": len(ctx.control_events)}


@app.post("/matches/{match_id}/sim/stop")
async def stop_sim(match_id: str):
    ctx = get_context(match_id)
    if ctx.publisher:
        await ctx.publisher.stop()
    ctx.clock.pause()
    ctx.clock.status = "ended"
    return {
        "status": ctx.clock.status,
        "liveTimeSec": ctx.clock.liveTimeSec,
        "lastStoredSec": ctx.store.get_last_time(),
    }


@app.get("/matches/{match_id}/meta")
async def get_meta(match_id: str):
    ctx = get_context(match_id)
    meta = ctx.store.get_meta()
    if not meta:
        raise HTTPException(status_code=404, detail="No match meta")
    return meta


@app.get("/matches/{match_id}/status")
async def get_status(match_id: str):
    ctx = get_context(match_id)
    last_time = ctx.store.get_last_time()
    return {
        "status": ctx.clock.status,
        "liveTimeSec": ctx.clock.liveTimeSec,
        "last_time": last_time,
        "last_minute": last_time // 60,
        "is_running": ctx.clock.status == "running",
    }


def _compute_summary(ctx: MatchContext) -> dict:
    max_sec = ctx.store.get_last_time()
    events = ctx.store.get_range(0, max_sec, kind="events")
    score = {"Team_A": 0, "Team_B": 0}
    shots = {"Team_A": 0, "Team_B": 0}
    passes = {"Team_A": 0, "Team_B": 0}
    for evt in events:
        team = evt.team
        if evt.eventType == "shot":
            shots[team] += 1
            if evt.success:
                score[team] += 1
        if evt.eventType == "pass" and evt.success:
            passes[team] += 1
    total_passes = passes["Team_A"] + passes["Team_B"]
    possession = {
        "Team_A": (passes["Team_A"] / total_passes) if total_passes else 0.5,
        "Team_B": (passes["Team_B"] / total_passes) if total_passes else 0.5,
    }
    return {
        "score": score,
        "shots": shots,
        "possession": possession,
        "passes": passes,
        "liveTimeSec": ctx.clock.liveTimeSec,
    }


@app.get("/matches/{match_id}/summary")
async def get_summary(match_id: str):
    ctx = get_context(match_id)
    summary = _compute_summary(ctx)
    return summary


@app.get("/matches/{match_id}/analytics")
async def get_analytics(match_id: str, minute: Optional[int] = None):
    ctx = get_context(match_id)
    target_minute = minute if minute is not None else (ctx.store.get_last_time() // 60)
    use_db = ctx.is_imported or frame_repo.has_frames(match_id)
    available_min, available_max = (None, None)
    if use_db:
        available_min, available_max = frame_repo.get_available_minutes(match_id)
        if available_min is None or available_max is None:
            use_db = False
    if use_db and (target_minute < available_min or target_minute > available_max):
        pos_frames = []
        evt_frames = []
        phy_frames = []
        pos_records = []
        events_records = []
        physical_records = []
        no_data = True
    elif use_db:
        pos_records = frame_repo.get_frames_up_to_minute(match_id, "pos", target_minute)
        events_records = frame_repo.get_frames_up_to_minute(match_id, "evt", target_minute)
        physical_records = frame_repo.get_frames_up_to_minute(match_id, "phy", target_minute)
        pos_frames = pos_records
        evt_frames = events_records
        phy_frames = physical_records
        no_data = not pos_records and not events_records and not physical_records
    else:
        all_positions = ctx.store.all_positions()
        all_events = ctx.store.all_events()
        all_physical = ctx.store.all_physical()
        available_min, available_max = _minmax_minutes_from_sources(
            all_positions, all_events, all_physical
        )
        if available_min is not None and (
            target_minute < available_min or target_minute > available_max
        ):
            pos_frames = []
            evt_frames = []
            phy_frames = []
            pos_records = []
            events_records = []
            physical_records = []
            no_data = True
        else:
            pos_frames = [frame for frame in all_positions if frame.minute <= target_minute]
            evt_frames = [frame for frame in all_events if frame.minute <= target_minute]
            phy_frames = [frame for frame in all_physical if frame.minute <= target_minute]
            pos_records = [_frame_to_row(frame, "pos") for frame in pos_frames]
            events_records = [_frame_to_row(frame, "evt") for frame in evt_frames]
            physical_records = [_frame_to_row(frame, "phy") for frame in phy_frames]
            no_data = not pos_frames and not evt_frames and not phy_frames
    pos_min, pos_max = _minmax_minutes_from_sources(pos_frames)
    evt_min, evt_max = _minmax_minutes_from_sources(evt_frames)
    phy_min, phy_max = _minmax_minutes_from_sources(phy_frames)
    logger.info(
        "analytics target_minute=%s pos_min=%s pos_max=%s evt_min=%s evt_max=%s phy_min=%s phy_max=%s source=%s",
        target_minute,
        pos_min,
        pos_max,
        evt_min,
        evt_max,
        phy_min,
        phy_max,
        "db" if use_db else "memory",
    )
    logger.debug("RAW events sample: %s", events_records[:2])
    logger.debug(
        "RAW event keys: %s",
        list(events_records[0].keys()) if events_records else [],
    )
    pos_df, evt_df, phy_df, stats_df = normalize_frames_to_dfs(
        pos_records, physical_records, events_records, stats=None
    )
    logger.debug("pos_df columns: %s", pos_df.columns.tolist())
    logger.debug("phy_df columns: %s", phy_df.columns.tolist())
    logger.debug("evt_df columns: %s", evt_df.columns.tolist())
    logger.debug("evt_df head: %s", evt_df.head(2).to_dict(orient="records"))

    if "team" not in pos_df.columns:
        raise HTTPException(
            status_code=500,
            detail=f"pos_df missing team after normalize. cols={list(pos_df.columns)}",
        )
    if "event_type" not in evt_df.columns:
        raise HTTPException(
            status_code=500,
            detail=f"evt_df missing event_type after normalize. cols={list(evt_df.columns)}",
        )

    try:
        end_first_half, end_second_half = _match_bounds(ctx.settings)
        snapshot = build_analytics_snapshot(
            target_minute,
            pos_df,
            evt_df,
            phy_df,
        )
        snapshot["minute"] = target_minute
        snapshot["available_minutes"] = {"min": available_min, "max": available_max}
        snapshot["data_mode"] = "static_import" if use_db else "live_simulation"
        snapshot["is_imported"] = bool(use_db)
        snapshot["match_state"] = build_match_state(
            target_minute,
            pos_frames,
            evt_frames,
            control_events=ctx.control_events,
            rosters=ctx.rosters,
            match_length=end_second_half,
            halftime=end_first_half,
            clock_status=ctx.clock.status,
            no_data=no_data,
        )
        snapshot["no_data"] = no_data
        snapshot = to_jsonable(snapshot)
        return jsonable_encoder(
            snapshot,
            custom_encoder={
                np.integer: int,
                np.floating: float,
                np.bool_: bool,
                np.ndarray: lambda v: v.tolist(),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Analytics failure", exc_info=exc)
        raise HTTPException(status_code=500, detail=f"Analytics failure: {exc}")


@app.get("/matches/{match_id}/recommendations")
async def get_recommendations(match_id: str, minute: Optional[int] = None):
    ctx = get_context(match_id)
    target_minute = _resolve_target_minute(ctx, match_id, minute)
    info = await _compute_recos_async(ctx, match_id, target_minute)
    recos = ctx.reco_repo.get_minute(match_id, target_minute)
    return {
        "minute": target_minute,
        "recommendations": recos,
        "last_computed_minute": ctx.reco_repo.get_last_computed_minute(match_id),
        "target_max_minute": info.get("target_max_minute"),
        "phase": info.get("phase"),
    }


@app.post("/matches/{match_id}/recommendations/backfill")
async def backfill_recommendations(match_id: str, to_minute: int = Query(..., ge=0)):
    ctx = get_context(match_id)
    _, end_second_half = _match_bounds(ctx.settings)
    target_minute = min(max(0, int(to_minute)), end_second_half)
    info = await _compute_recos_async(ctx, match_id, target_minute)
    return {
        "match_id": match_id,
        "to_minute": target_minute,
        "last_computed_minute": ctx.reco_repo.get_last_computed_minute(match_id),
        "written_recos": info.get("written_recos", 0),
        "stored_minutes": len(info.get("stored", {})),
    }


@app.get("/matches/{match_id}/recommendations/debug")
async def get_recommendations_debug(match_id: str, minute: Optional[int] = None):
    ctx = get_context(match_id)
    target_minute = _resolve_target_minute(ctx, match_id, minute)
    info = await _compute_recos_async(ctx, match_id, target_minute)
    end_first_half, end_second_half = _match_bounds(ctx.settings)
    return {
        "match_id": match_id,
        "minute": target_minute,
        "phase": info.get("phase"),
        "last_computed_minute": ctx.reco_repo.get_last_computed_minute(match_id),
        "target_max_minute": info.get("target_max_minute"),
        "settings": ctx.settings.model_dump(),
        "bounds": {"end_first_half": end_first_half, "end_second_half": end_second_half},
        "counts": {
            "total": ctx.reco_repo.count_total(match_id),
            "minute": ctx.reco_repo.count_minute(match_id, target_minute),
        },
        "written_recos": info.get("written_recos", 0),
        "stored": info.get("stored", {}),
    }


@app.get("/matches/{match_id}/state")
async def get_match_state(match_id: str, minute: Optional[int] = None):
    ctx = get_context(match_id)
    target_minute = minute if minute is not None else (ctx.store.get_last_time() // 60)
    use_db = ctx.is_imported or frame_repo.has_frames(match_id)
    available_min, available_max = (None, None)
    if use_db:
        available_min, available_max = frame_repo.get_available_minutes(match_id)
        if available_min is None or available_max is None:
            use_db = False
    if use_db and (target_minute < available_min or target_minute > available_max):
        pos_frames = []
        evt_frames = []
        phy_frames = []
        no_data = True
    elif use_db:
        pos_frames = frame_repo.get_frames_up_to_minute(match_id, "pos", target_minute)
        evt_frames = frame_repo.get_frames_up_to_minute(match_id, "evt", target_minute)
        phy_frames = frame_repo.get_frames_up_to_minute(match_id, "phy", target_minute)
        no_data = not pos_frames and not evt_frames and not phy_frames
    else:
        all_positions = ctx.store.all_positions()
        all_events = ctx.store.all_events()
        all_physical = ctx.store.all_physical()
        available_min, available_max = _minmax_minutes_from_sources(
            all_positions, all_events, all_physical
        )
        if available_min is not None and (
            target_minute < available_min or target_minute > available_max
        ):
            pos_frames = []
            evt_frames = []
            phy_frames = []
            no_data = True
        else:
            pos_frames = [frame for frame in all_positions if frame.minute <= target_minute]
            evt_frames = [frame for frame in all_events if frame.minute <= target_minute]
            phy_frames = [frame for frame in all_physical if frame.minute <= target_minute]
            no_data = not pos_frames and not evt_frames and not phy_frames
    end_first_half, end_second_half = _match_bounds(ctx.settings)
    state = build_match_state(
        target_minute,
        pos_frames,
        evt_frames,
        control_events=ctx.control_events,
        rosters=ctx.rosters,
        match_length=end_second_half,
        halftime=end_first_half,
        clock_status=ctx.clock.status,
        no_data=no_data,
    )
    state["available_minutes"] = {"min": available_min, "max": available_max}
    return jsonable_encoder(state)


@app.get("/matches/{match_id}/debug")
async def get_debug(match_id: str):
    ctx = get_context(match_id)
    meta = ctx.store.get_meta()
    connected = await ctx.ws_manager.count_clients(match_id)
    return {
        "counts": ctx.store.get_counts(),
        "last_time": ctx.store.get_last_time(),
        "status": ctx.clock.status,
        "connected": connected,
        "meta": meta.dict() if meta else None,
    }


def _frame_to_row(frame, kind: str) -> dict:
    if kind == "pos":
        return {
            "time": frame.time,
            "minute": frame.minute,
            "player_id": frame.playerId,
            "team": frame.team,
            "role": frame.role,
            "x": frame.x,
            "y": frame.y,
        }
    if kind == "phy":
        return {
            "time": frame.time,
            "minute": frame.minute,
            "player_id": frame.playerId,
            "team": frame.team,
            "speed": frame.speed,
            "fatigue": frame.fatigue,
        }
    return {
        "time": frame.time,
        "minute": frame.minute,
        "player_id": frame.playerId,
        "team": frame.team,
        "event_type": frame.eventType,
        "x": frame.x,
        "y": frame.y,
        "success": frame.success,
        "momentum": frame.momentum,
        "xG": frame.xG,
    }


def _write_csv(writer: csv.DictWriter, rows: List[dict]) -> None:
    writer.writeheader()
    for row in rows:
        writer.writerow(row)


def _build_stats(ctx: MatchContext) -> List[dict]:
    last_time = ctx.store.get_last_time()
    max_minute = last_time // 60 if last_time >= 0 else 0
    cum_passes = {"Team_A": 0, "Team_B": 0}
    cum_shots = {"Team_A": 0, "Team_B": 0}
    rows = []
    for minute in range(max_minute + 1 if last_time >= 0 else 1):
        events = ctx.store.get_range(minute * 60, minute * 60 + 59, kind="events")
        for evt in events:
            if evt.eventType == "pass" and evt.success:
                cum_passes[evt.team] += 1
            if evt.eventType == "shot":
                cum_shots[evt.team] += 1
        total_passes = cum_passes["Team_A"] + cum_passes["Team_B"]
        possession_a = (cum_passes["Team_A"] / total_passes) if total_passes else 0.5
        possession_b = (cum_passes["Team_B"] / total_passes) if total_passes else 0.5
        rows.append(
            {
                "minute": minute,
                "possession_Team_A": round(possession_a, 3),
                "possession_Team_B": round(possession_b, 3),
                "shots_Team_A": cum_shots["Team_A"],
                "shots_Team_B": cum_shots["Team_B"],
            }
        )
    return rows


def _minmax_minutes(frames: Sequence) -> tuple[Optional[int], Optional[int]]:
    if not frames:
        return None, None
    minutes = [getattr(frame, "minute", None) for frame in frames]
    minutes = [m for m in minutes if m is not None]
    if not minutes:
        return None, None
    return min(minutes), max(minutes)


def _minmax_minutes_from_sources(*sources: Sequence) -> tuple[Optional[int], Optional[int]]:
    minutes: List[int] = []
    for frames in sources:
        for frame in frames:
            if isinstance(frame, dict):
                minute_val = frame.get("minute")
            else:
                minute_val = getattr(frame, "minute", None)
            if minute_val is None:
                continue
            minutes.append(int(minute_val))
    if not minutes:
        return None, None
    return min(minutes), max(minutes)


@app.get("/matches/{match_id}/export.zip")
async def export_match_data(match_id: str):
    ctx = get_context(match_id)
    positions = ctx.store.all_positions()
    physical = ctx.store.all_physical()
    events = ctx.store.all_events()
    stats_rows = _build_stats(ctx)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        def _add_csv(name: str, fieldnames: List[str], rows: List[dict]) -> None:
            text_buf = io.StringIO()
            writer = csv.DictWriter(text_buf, fieldnames=fieldnames)
            _write_csv(writer, rows)
            zf.writestr(name, text_buf.getvalue())

        _add_csv(
            "positions.csv",
            ["time", "minute", "player_id", "team", "role", "x", "y"],
            [_frame_to_row(frame, "pos") for frame in positions],
        )
        _add_csv(
            "physical.csv",
            ["time", "minute", "player_id", "team", "speed", "fatigue"],
            [_frame_to_row(frame, "phy") for frame in physical],
        )
        _add_csv(
            "events.csv",
            [
                "time",
                "minute",
                "player_id",
                "team",
                "event_type",
                "x",
                "y",
                "success",
                "momentum",
                "xG",
            ],
            [_frame_to_row(frame, "evt") for frame in events],
        )
        _add_csv(
            "stats.csv",
            ["minute", "possession_Team_A", "possession_Team_B", "shots_Team_A", "shots_Team_B"],
            stats_rows,
        )
    buf.seek(0)
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"match_export_{timestamp}.zip"
    headers = {
        "Content-Disposition": f"attachment; filename={filename}",
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


@app.post("/matches/{match_id}/clock/init")
async def clock_init(match_id: str):
    ctx = get_context(match_id)
    ctx.clock.init_idle()
    return {"status": ctx.clock.status, "liveTimeSec": ctx.clock.liveTimeSec}


@app.post("/matches/{match_id}/clock/start")
async def clock_start(match_id: str):
    ctx = get_context(match_id)
    ctx.clock.start()
    return {"status": ctx.clock.status, "liveTimeSec": ctx.clock.liveTimeSec}


@app.post("/matches/{match_id}/clock/pause")
async def clock_pause(match_id: str):
    ctx = get_context(match_id)
    ctx.clock.pause()
    return {"status": ctx.clock.status, "liveTimeSec": ctx.clock.liveTimeSec}


@app.post("/matches/{match_id}/clock/resume")
async def clock_resume(match_id: str):
    ctx = get_context(match_id)
    ctx.clock.resume()
    return {"status": ctx.clock.status, "liveTimeSec": ctx.clock.liveTimeSec}


@app.get("/matches/{match_id}/clock")
async def clock_get(match_id: str):
    ctx = get_context(match_id)
    logger.info("clock/get match_id=%s clock_id=%s", match_id, id(ctx.clock))
    return {"status": ctx.clock.status, "liveTimeSec": ctx.clock.liveTimeSec}


@app.get("/matches/{match_id}/snapshot")
async def get_snapshot(match_id: str, time: int):
    ctx = get_context(match_id)
    snapshot = ctx.store.get_snapshot(time)
    return snapshot


@app.get("/matches/{match_id}/range")
async def get_range(
    match_id: str,
    from_sec: int = Query(..., alias="from"),
    to_sec: int = Query(..., alias="to"),
    kind: str = "events",
):
    ctx = get_context(match_id)
    return {"values": ctx.store.get_range(from_sec, to_sec, kind=kind)}


@app.websocket("/ws/matches/{match_id}/live")
@app.websocket("/ws/matches/{match_id}")
async def live_ws(websocket: WebSocket, match_id: str):
    session = await authorize_websocket(websocket, "viewer")
    if session is None:
        return
    ctx = get_context(match_id)
    await websocket.accept()
    await ctx.ws_manager.register(match_id, websocket)
    try:
        meta = ctx.store.get_meta()
        if meta:
            await websocket.send_text(json.dumps({"type": "meta", "payload": meta.dict()}))
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        await ctx.ws_manager.unregister(match_id, websocket)
