import { Effects, type Projectile } from "./effects";
import {
  GestureInterpreter,
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
  status(text: string): void;
  spellLabel(text: string): void;
  ko(text: string): void;
}

interface SmoothedPalm extends PalmPoint {
  x: number; // screen px
  y: number;
  frame: boolean; // hand is in "L" pose — part of the portal, excluded from spells/shield
}

export class Game {
  hpMe = MAX_HP;
  hpFoe = MAX_HP;
  over = false;
  private interp = new GestureInterpreter();
  private smooth: SmoothedPalm[] = [];
  private smoothQuad: { x: number; y: number }[] | null = null;

  constructor(
    private fx: Effects,
    private net: Session,
    private ui: GameUi,
  ) {}

  /** Frame results from the tracker (normalized landmarks, raw camera space). */
  onHands(hands: TrackedHand[]): void {
    if (this.over) return;
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
      this.fx.shieldX = shield.x;
      this.fx.shieldY = shield.y;
    }

    // "рамка" из двух L-образных рук — портал-щит (как в референсе)
    const frameHands = hands.filter(isFrameHand);
    if (frameHands.length >= 2) {
      // screen-left hand = largest camera x (mirrored view)
      const [left, right] = frameHands
        .slice(0, 2)
        .sort((a, b) => toScreen(a.landmarks[0].x, 0).x - toScreen(b.landmarks[0].x, 0).x);
      const quad = portalQuadPoints(left, right, toScreen);
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

    const intent = this.interp.update(castPalms, performance.now());
    if (intent) this.cast(intent.spell.id, intent.nx, intent.ny);
  }

  cast(spellId: string, nx: number, ny: number): void {
    const spell = SPELLS[spellId];
    if (!spell || this.over) return;
    this.ui.spellLabel(spell.name);
    if (spell.heal > 0) {
      this.hpMe = Math.min(MAX_HP, this.hpMe + spell.heal);
      this.ui.hpMe(this.hpMe);
      this.fx.healPulse();
      this.net.sendHp(this.hpMe);
      return;
    }
    const s = this.fx.camToScreen(1 - nx, ny); // un-mirror: nx is mirrored screen space
    this.fx.spawnOutgoing(spell, s.x, s.y);
    this.net.sendCast({ s: spellId, x: nx });
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
    this.fx.burst(this.fx.width / 2, this.fx.height * 0.86, spell.color, 24);
    this.ui.status(`${spell.name}: заблокирован щитом!`);
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
            this.fx.shieldRadius + p.spell.radius;
        if (blockedByPalm || this.fx.portalContains(p.x, p.y)) {
          p.dead = true;
          this.fx.burst(p.x, p.y, 0x66d9ff, 30);
          this.net.sendBlocked(p.spell.id);
        }
      }
    }
    this.fx.update(dt, (p) => this.impact(p));
  }

  /** Incoming projectile reached the viewer — a hit. */
  private impact(p: Projectile): void {
    if (this.over) return;
    this.hpMe = Math.max(0, this.hpMe - p.spell.damage);
    this.ui.hpMe(this.hpMe);
    this.fx.hitFlash();
    this.fx.burst(p.x, p.y, p.spell.color, 50);
    this.net.sendHp(this.hpMe);
    if (this.hpMe <= 0) {
      this.over = true;
      this.ui.ko("ПОРАЖЕНИЕ");
      this.net.sendKo();
    }
  }

  onRemoteHp(hp: number): void {
    this.hpFoe = hp;
    this.ui.hpFoe(hp);
  }

  onRemoteKo(): void {
    this.over = true;
    this.ui.ko("ПОБЕДА");
  }
}
