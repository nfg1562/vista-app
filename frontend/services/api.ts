import { MATCH_ID } from "./env";
import { apiFetch, API_BASE } from "./http";

const BASE = `${API_BASE}/matches/${MATCH_ID}`;

async function sendJson(path: string, method = "POST") {
  try {
    return await apiFetch(`${BASE}${path}`, { method });
  } catch (error) {
    console.error(`API ${method} ${path} failed`, error);
    throw error;
  }
}

export async function initClock() {
  return sendJson("/clock/init");
}

export async function startClock() {
  return sendJson("/clock/start");
}

export async function pauseClock() {
  return sendJson("/clock/pause");
}

export async function resumeClock() {
  return sendJson("/clock/resume");
}

export async function getClock() {
  const response = await apiFetch(`${BASE}/clock`);
  if (!response.ok) {
    throw new Error("Clock unavailable");
  }
  return response.json();
}

export async function initSim() {
  return sendJson("/sim/init");
}

export async function startSim() {
  return sendJson("/sim/start");
}

export async function getMatchConfig() {
  const response = await apiFetch(`${BASE}/config`);
  if (!response.ok) {
    throw new Error("Match config unavailable");
  }
  return response.json();
}
