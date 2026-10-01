import type { TrackedHand } from "./tracker.worker";

export interface Spell {
  id: string;
  name: string;
  gesture: string;
  damage: number;
  heal: number;
  /** flight time of the incoming projectile on the victim's screen, seconds */
  flightTime: number;
  radius: number;
  color: number;
  cooldown: number;
}

export const SPELLS: Record<string, Spell> = {
  fireball: { id: "fireball", name: "Файербол", gesture: "Closed_Fist", damage: 10, heal: 0, flightTime: 1.15, radius: 60, color: 0xff7a18, cooldown: 0.9 },
  shard:    { id: "shard",    name: "Лёд",      gesture: "Victory",     damage: 6,  heal: 0, flightTime: 0.75, radius: 38, color: 0x6fd7ff, cooldown: 0.55 },
  storm:    { id: "storm",    name: "Шторм",    gesture: "ILoveYou",    damage: 18, heal: 0, flightTime: 1.5,  radius: 95, color: 0xb04df0, cooldown: 2.2 },
  heal:     { id: "heal",     name: "Хил",      gesture: "Thumb_Up",    damage: 0,  heal: 8, flightTime: 0,    radius: 0,  color: 0x4df08a, cooldown: 4 },
  bolt:     { id: "bolt",     name: "Болт",     gesture: "Pointing_Up", damage: 4,  heal: 0, flightTime: 0.5,  radius: 30, color: 0xf0e54d, cooldown: 0.35 },
};

export const SHIELD_GESTURE = "Open_Palm";
const MIN_SCORE = 0.5;

// --- landmark indices ---
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

const nd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

// Palm center = mean of wrist + finger MCPs — stable under finger motion.
const PALM_POINTS = [0, 5, 9, 13, 17];

export function palmCenter(hand: TrackedHand): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const i of PALM_POINTS) {
    x += hand.landmarks[i].x;
    y += hand.landmarks[i].y;
  }
  return { x: x / PALM_POINTS.length, y: y / PALM_POINTS.length };
}

/**
 * "L" frame hand (the portal gesture from the reference demo):
 * index + thumb extended and spread wide; middle/ring/pinky curled.
 * Curled check separates it from Open_Palm (shield).
 */
export function isFrameHand(hand: TrackedHand): boolean {
  const lm = hand.landmarks;
  const size = nd(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6;
  const spread = nd(lm[THUMB_TIP], lm[INDEX_TIP]) / size;
  const indexExtended = nd(lm[INDEX_TIP], lm[WRIST]) > nd(lm[INDEX_PIP], lm[WRIST]) * 1.1;
  const thumbOut = nd(lm[THUMB_TIP], lm[INDEX_MCP]) / size > 0.55;
  const curled = [MIDDLE_TIP, RING_TIP, PINKY_TIP].every(
    (tip, i) => nd(lm[tip], lm[WRIST]) < nd(lm[[MIDDLE_PIP, RING_PIP, PINKY_PIP][i]], lm[WRIST]) * 1.08,
  );
  return spread > 0.8 && indexExtended && thumbOut && curled;
}

/** Portal corners via the camera→screen mapping: [left index, right index, right thumb, left thumb]. */
export function portalQuadPoints(
  left: TrackedHand,
  right: TrackedHand,
  toScreen: (nx: number, ny: number) => { x: number; y: number },
): { x: number; y: number }[] {
  return [
    toScreen(left.landmarks[INDEX_TIP].x, left.landmarks[INDEX_TIP].y),
    toScreen(right.landmarks[INDEX_TIP].x, right.landmarks[INDEX_TIP].y),
    toScreen(right.landmarks[THUMB_TIP].x, right.landmarks[THUMB_TIP].y),
    toScreen(left.landmarks[THUMB_TIP].x, left.landmarks[THUMB_TIP].y),
  ];
}

export interface CastIntent {
  spell: Spell;
  nx: number; // normalized 0..1, mirrored screen space
  ny: number;
}

/** A palm already reduced to a point (normalized, mirrored space) + classified gesture. */
export interface PalmPoint {
  nx: number;
  ny: number;
  gesture: string;
  score: number;
}

export class GestureInterpreter {
  private active = new Set<string>();
  private cooldownUntil = new Map<string, number>();

  /** Returns a cast intent when a spell gesture *starts* (edge-triggered + cooldown). */
  update(palms: PalmPoint[], now: number): CastIntent | null {
    const seen = new Set<string>();
    let intent: CastIntent | null = null;

    for (const palm of palms) {
      if (palm.score < MIN_SCORE) continue;
      const spell = Object.values(SPELLS).find((s) => s.gesture === palm.gesture);
      if (!spell) continue;
      seen.add(spell.id);
      if (this.active.has(spell.id) || now < (this.cooldownUntil.get(spell.id) ?? 0)) continue;
      intent = { spell, nx: palm.nx, ny: palm.ny };
      this.cooldownUntil.set(spell.id, now + spell.cooldown * 1000);
    }

    this.active = seen;
    return intent;
  }
}

export function shieldPalm<T extends PalmPoint>(palms: T[]): T | null {
  return palms.find((p) => p.gesture === SHIELD_GESTURE && p.score >= MIN_SCORE) ?? null;
}
