from __future__ import annotations


def map_external_event(e: dict) -> dict:
    time_s = int(e.get("time_s", 0))
    minute = int(e.get("minute", time_s // 60))
    team = e.get("team", "Team_A")
    player_id = e.get("player_id", "unknown")
    event_type = e.get("type", "pass")
    x = float(e.get("x", 50.0))
    y = float(e.get("y", 25.0))
    success = bool(e.get("success", False))
    momentum = float(e.get("momentum", 0.5))
    xG = float(e.get("xG", 0.0))
    return {
        "time": time_s,
        "minute": minute,
        "player_id": player_id,
        "team": team,
        "event_type": event_type,
        "x": x,
        "y": y,
        "success": success,
        "momentum": momentum,
        "xG": xG,
    }


def map_external_position(p: dict) -> dict:
    time_s = int(p.get("time_s", 0))
    return {
        "time": time_s,
        "minute": int(p.get("minute", time_s // 60)),
        "player_id": p.get("player_id", "unknown"),
        "team": p.get("team", "Team_A"),
        "role": p.get("role", "MID"),
        "x": float(p.get("x", 50)),
        "y": float(p.get("y", 25)),
    }


def map_external_physical(ph: dict) -> dict:
    time_s = int(ph.get("time_s", 0))
    minute = int(ph.get("minute", time_s // 60))
    return {
        "time": time_s,
        "minute": minute,
        "player_id": ph.get("player_id", "unknown"),
        "team": ph.get("team", "Team_A"),
        "speed": float(ph.get("speed", 5.0)),
        "fatigue": float(ph.get("fatigue", 0.4)),
    }
