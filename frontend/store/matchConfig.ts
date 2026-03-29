export const MATCH_CONFIG_KEY = "vista_match_config_v1";

export type MatchInfo = {
  title: string;
  competition: string;
  fixture_id: string;
  home: string;
  away: string;
  home_initials: string;
  away_initials: string;
  matchLength: number;
  halftime: number;
};

export type RosterRow = {
  numero: number | string;
  nom: string;
};

export type RosterConfig = {
  homeStarting: RosterRow[];
  awayStarting: RosterRow[];
  homeBench: RosterRow[];
  awayBench: RosterRow[];
};

export type MatchConfig = {
  matchInfo: MatchInfo;
  roster: RosterConfig;
};

function buildStartingRows(offset = 1): RosterRow[] {
  return Array.from({ length: 11 }, (_, idx) => ({
    numero: offset + idx,
    nom: "",
  }));
}

export function getDefaultMatchConfig(): MatchConfig {
  return {
    matchInfo: {
      title: "Match à analyser",
      competition: "Competition",
      fixture_id: "",
      home: "Team_A",
      away: "Team_B",
      home_initials: "",
      away_initials: "",
      matchLength: 90,
      halftime: 45,
    },
    roster: {
      homeStarting: buildStartingRows(1),
      awayStarting: buildStartingRows(1),
      homeBench: [],
      awayBench: [],
    },
  };
}

export function saveMatchConfig(config: MatchConfig) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(MATCH_CONFIG_KEY, JSON.stringify(config));
}

export function loadMatchConfig(): MatchConfig | null {
  if (typeof window === "undefined") {
    return null;
  }
  const payload = window.localStorage.getItem(MATCH_CONFIG_KEY);
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as MatchConfig;
  } catch {
    return null;
  }
}

export function resetMatchConfig(): MatchConfig {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(MATCH_CONFIG_KEY);
  }
  return getDefaultMatchConfig();
}
