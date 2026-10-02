import { Effects, type Projectile } from "./effects";
import {
  GestureInterpreter,
  MIN_SCORE,
  SPELLS,
  isFrameHand,
  palmCenter,
  portalQuadPoints,
  shieldPalm,
  type PalmPoint,
} from "./spells";
import type { Session } from "./net";
import type { TrackedHand } from "./tracker.worker";

const MAX_HP = 100;
const SMOOTH = 0.45;

export interface GameUi {
  hpMe(hp: number): void;
  hpFoe(hp: number): void;
  toast(text: string): void;
  /** Currently recognized gesture for the spellbar: spellId | "shield" | "portal" | null. */
  gesture(g: string | null): void;
  /** A spell was actually cast (flash its icon). */
  castFx(spellId: string): void;
  /** Which edges of the own panel a palm is about to leave: "l" | "r" | "t" | "b". */
  frameEdges(edges: string[]): void;
}

interface SmoothedPalm extends PalmPoint {
  x: number; // screen px
  y: number;
  frame: boolean; // hand is in "L" pose — part of the portal, excluded from spells/shield
}

const SPELL_BY_GESTURE = new Map(Object.values(SPELLS).map((s) => [s.gesture, s]));

export class Game {
  hpMe = MAX_HP;
  hpFoe = MAX_HP;
  over = false;
  result: "win" | "lose" | null = null;
  /** Network sends enabled (off while waiting for a peer). */
  armed = false;
  /** Casts and damage ignored (during the countdown). */
  locked = false;
  private interp = new GestureInterpreter();
  private smooth: SmoothedPalm[] = [];
  private smoothQuad: { x: number; y: number }[] | null = null;
  private lastCastNx = new Map<string, number>();

  constructor(
    private fx: Effects,
    private net: Session,
    private ui: GameUi,
  ) {}

  cooldownLeft(spellId: string): number {
    return this.interp.cooldownLeft(spellId, performance.now());
  }

  reset(): void {
    this.hpMe = this.hpFoe = MAX_HP;
    this.over = false;
    this.result = null;
    this.interp.reset();
    this.smooth = [];
    this.smoothQuad = null;
    this.lastCastNx.clear();
    this.fx.clearProjectiles();
    this.fx.shieldActive = false;
    this.fx.setPortal(null);
    this.ui.hpMe(this.hpMe);
    this.ui.hpFoe(this.hpFoe);
    this.ui.gesture(null);
    this.ui.frameEdges([]);
  }

  /** Frame results from the tracker (normalized landmarks, raw camera space). */
  onHands(hands: TrackedHand[]): void {
    if (this.over) {
      this.ui.gesture(null);
      this.ui.frameEdges([]);
      return;
    }
    const w = this.fx.width;

    // normalized camera-space palm → screen px (cover-crop + mirror mapping), EMA-smoothed
    const toScreen = (nx: number, ny: number) => this.fx.camToScreen(nx, ny);
    const detected = hands.map((hand) => {
      const p = palmCenter(hand);
      const s = toScreen(p.x, p.y);
      return {
        nx: 1 - p.x,
        ny: p.y,
        x: s.x,
        y: s.y,
        gesture: hand.gesture,
        score: hand.score,
        frame: isFrameHand(hand),
      };
    });
    this.smooth = detected.map((d) => {
      let prev: SmoothedPalm | null = null;
      let best = Infinity;
      for (const s of this.smooth) {
        const dist = Math.hypot(s.x - d.x, s.y - d.y);
        if (dist < best) {
          best = dist;
          prev = s;
        }
      }
      return prev && best < w * 0.3
        ? { ...d, x: prev.x + (d.x - prev.x) * SMOOTH, y: prev.y + (d.y - prev.y) * SMOOTH }
        : d;
    });

    const castPalms = this.smooth.filter((p) => !p.frame);
    const shield = shieldPalm(castPalms);
    this.fx.shieldActive = shield !== null;
    if (shield) {
      const c = this.fx.clampMe(shield.x, shield.y, 8);
      this.fx.shieldX = c.x;
      this.fx.shieldY = c.y;
    }

    // "рамка" из двух L-образных рук — портал-щит (как в референсе)
    const frameHands = hands.filter(isFrameHand);
    if (frameHands.length >= 2) {
      // screen-left hand = largest camera x (mirrored view)
      const [left, right] = frameHands
        .slice(0, 2)
        .sort((a, b) => toScreen(a.landmarks[0].x, 0).x - toScreen(b.landmarks[0].x, 0).x);
      const quad = portalQuadPoints(left, right, toScreen).map((p) =>
        this.fx.clampMe(p.x, p.y, 10),
      );
      this.smoothQuad = this.smoothQuad
        ? quad.map((p, i) => ({
            x: this.smoothQuad![i].x + (p.x - this.smoothQuad![i].x) * SMOOTH,
            y: this.smoothQuad![i].y + (p.y - this.smoothQuad![i].y) * SMOOTH,
          }))
        : quad;
      this.fx.setPortal(this.smoothQuad);
    } else {
      this.smoothQuad = null;
      this.fx.setPortal(null);
    }

    // spellbar feedback: which gesture is currently recognized
    let g: string | null = null;
    if (frameHands.length >= 2) g = "portal";
    else if (shield) g = "shield";
    else {
      for (const p of castPalms) {
        const spell = p.score >= MIN_SCORE ? SPELL_BY_GESTURE.get(p.gesture) : undefined;
        if (spell) {
          g = spell.id;
          break;
        }
      }
    }
    this.ui.gesture(g);

    // warn when a palm is about to leave the visible area
    const r = this.fx.layoutResult?.me;
    if (r) {
      const edges = new Set<string>();
      for (const p of this.smooth) {
        if (p.frame) continue;
        if (p.x < r.x + r.w * 0.06) edges.add("l");
        if (p.x > r.x + r.w * 0.94) edges.add("r");
        if (p.y < r.y + r.h * 0.06) edges.add("t");
        if (p.y > r.y + r.h * 0.94) edges.add("b");
      }
      this.ui.frameEdges([...edges]);
    }

    const intent = this.interp.update(castPalms, performance.now());
    if (intent && !this.locked) this.cast(intent.spell.id, intent.nx, intent.ny);
  }

  cast(spellId: string, nx: number, ny: number): void {
    const spell = SPELLS[spellId];
    if (!spell || this.over || this.locked) return;
    this.ui.castFx(spell.id);
    if (spell.heal > 0) {
      this.hpMe = Math.min(MAX_HP, this.hpMe + spell.heal);
      this.ui.hpMe(this.hpMe);
      this.fx.healPulse();
      if (this.armed) this.net.sendHp(this.hpMe);
      return;
    }
    this.lastCastNx.set(spellId, nx);
    const s = this.fx.camToScreen(1 - nx, ny); // un-mirror: nx is mirrored screen space
    this.fx.spawnOutgoing(spell, s.x, s.y);
    if (this.armed) this.net.sendCast({ s: spellId, x: nx });
  }

  /** Opponent's cast arrived over the wire. */
  onRemoteCast(spellId: string, senderX: number): void {
    const spell = SPELLS[spellId];
    if (!spell || this.over) return;
    this.fx.spawnIncoming(spell, 1 - senderX); // mirror: their left = our right
  }

  /** Our outgoing projectile was swatted by the opponent's shield. */
  onRemoteBlocked(spellId: string): void {
    const spell = SPELLS[spellId];
    if (!spell) return;
    const e = this.fx.outgoingExitPoint(spellId, this.lastCastNx.get(spellId) ?? 0.5);
    this.fx.burst(e.x, e.y, spell.color, 24);
    this.ui.toast(`${spell.name}: заблокирован щитом!`);
  }

  update(dt: number): void {
    // shield + portal collision for incoming projectiles
    if (!this.over) {
      const shieldWorldY = this.fx.height - this.fx.shieldY;
      for (const p of this.fx.projectiles) {
        if (!p.incoming || p.dead) continue;
        const blockedByPalm =
          this.fx.shieldActive &&
          Math.hypot(p.x - this.fx.shieldX, p.y - shieldWorldY) <
            this.fx.shieldRadius + p.spell.radius * this.fx.sizeScale;
        if (blockedByPalm || this.fx.portalContains(p.x, p.y)) {
          p.dead = true;
          this.fx.burst(p.x, p.y, 0x66d9ff, 30);
          if (this.armed) this.net.sendBlocked(p.spell.id);
        }
      }
    }
    this.fx.update(dt, (p) => this.impact(p));
  }

  /** Incoming projectile reached the viewer — a hit. */
  private impact(p: Projectile): void {
    if (this.over || this.locked || !this.armed) return;
    this.hpMe = Math.max(0, this.hpMe - p.spell.damage);
    this.ui.hpMe(this.hpMe);
    this.fx.hitFlash();
    this.fx.burst(p.x, p.y, p.spell.color, 50);
    this.net.sendHp(this.hpMe);
    if (this.hpMe <= 0) {
      this.over = true;
      this.result = "lose";
      this.net.sendKo();
    }
  }

  onRemoteHp(hp: number): void {
    this.hpFoe = hp;
    this.ui.hpFoe(hp);
  }

  onRemoteKo(): void {
    this.over = true;
    this.result = "win";
  }
}
