export type MatchMetaPayload = {
  meta: true;
  fixture_id: number;
  fixtureId?: number;
  league: { id: number; name: string };
  home: { id: number; name: string };
  away: { id: number; name: string };
};

export type PositionPayload = {
  time: number;
  minute: number;
  player_id: string;
  team: string;
  role: string;
  x: number;
  y: number;
};

export type PhysicalPayload = {
  time: number;
  minute: number;
  player_id: string;
  team: string;
  speed: number;
  fatigue: number;
};

export type EventPayload = {
  time: number;
  minute: number;
  player_id: string;
  team: string;
  event_type: string;
  x: number;
  y: number;
  success: boolean;
  momentum: number;
  xG: number;
};

export type LiveMessage =
  | { type: "meta"; payload: MatchMetaPayload }
  | { type: "pos"; payload: PositionPayload }
  | { type: "phy"; payload: PhysicalPayload }
  | { type: "evt"; payload: EventPayload }
  | { type: "err"; payload: string };
