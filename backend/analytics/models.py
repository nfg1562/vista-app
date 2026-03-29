from __future__ import annotations

from typing import Dict, List, Literal, TypedDict


class ScoreSnapshot(TypedDict):
    score: Dict[str, int]
    shots: Dict[str, int]
    xg_totals: Dict[str, float]


class PossessionSnapshot(TypedDict):
    possession: Dict[str, float]
    pass_accuracy: Dict[str, float]


class XgXtLine(TypedDict):
    minute: int
    xG: float
    xT_gain: float
    shots: int
    line_breaks: int
    progressive_passes: int


class TopPlayerMetric(TypedDict):
    player_id: str
    value: float
    metric: Literal["xG", "xT"]


class XgXtSnapshot(TypedDict):
    summary: Dict[str, float]
    timeline: List[XgXtLine]
    top_players: List[TopPlayerMetric]


class RecommendationItem(TypedDict):
    category: str
    recommendation: str
    priority: int


class RecommendationsSnapshot(TypedDict):
    team: str
    items: List[RecommendationItem]


class MomentumSnapshot(TypedDict, total=False):
    value: float
    direction: Literal["up", "down", "flat"]


class AnalyticsSnapshot(TypedDict):
    score: ScoreSnapshot
    possession: PossessionSnapshot
    xg_xt: XgXtSnapshot
    recommendations: List[RecommendationsSnapshot]
    momentum: MomentumSnapshot
