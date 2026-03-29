from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field, ConfigDict, model_validator


def make_minute(time_sec: int) -> int:
    return time_sec // 60


class PositionFrame(BaseModel):
    time: int = Field(ge=0)
    minute: int
    playerId: str
    team: Literal["Team_A", "Team_B"]
    role: Literal["GK", "DEF", "MID", "FWD"]
    x: float
    y: float

    model_config = ConfigDict()

    @model_validator(mode="after")
    def validate_values(cls, values):
        time = values.time
        minute = values.minute
        computed = make_minute(time)
        if minute != computed:
            raise ValueError(f"minute ({minute}) must equal time//60 ({computed})")
        values.x = max(0.0, min(105.0, values.x))
        values.y = max(0.0, min(68.0, values.y))
        return values


class PhysicalFrame(BaseModel):
    time: int = Field(ge=0)
    minute: int
    playerId: str
    team: Literal["Team_A", "Team_B"]
    speed: float
    fatigue: float = Field(ge=0.0, le=1.0)

    model_config = ConfigDict()

    @model_validator(mode="after")
    def validate_minute(cls, values):
        computed = make_minute(values.time)
        if values.minute != computed:
            raise ValueError(f"minute ({values.minute}) must equal time//60 ({computed})")
        return values


class EventFrame(BaseModel):
    time: int = Field(ge=0)
    minute: int
    playerId: str
    team: Literal["Team_A", "Team_B"]
    eventType: Literal["pass", "cross", "shot", "tackle", "foul"]
    x: float
    y: float
    success: bool
    momentum: float = Field(ge=0.0, le=1.0)
    xG: float = Field(ge=0.0)

    model_config = ConfigDict()

    @model_validator(mode="after")
    def validate_values(cls, values):
        computed = make_minute(values.time)
        if values.minute != computed:
            raise ValueError(f"minute ({values.minute}) must equal time//60 ({computed})")
        values.x = max(0.0, min(105.0, values.x))
        values.y = max(0.0, min(68.0, values.y))
        return values


class MatchMeta(BaseModel):
    meta: Literal[True]
    fixtureId: int
    league: dict
    home: dict
    away: dict


class WSMessage(BaseModel):
    type: Literal["meta", "pos", "phy", "evt"]
    payload: Union[MatchMeta, PositionFrame, PhysicalFrame, EventFrame]
