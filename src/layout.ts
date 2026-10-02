/** Pure adaptive layout: picks stack/side and sizes video panels. No DOM, no three.js. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutInput {
  vw: number;
  vh: number; // CSS window size
  meAspect: number; // videoWidth / videoHeight of own camera
  foeAspect: number; // opponent camera aspect (until stream arrives = meAspect)
  safe: SafeInsets; // env(safe-area-inset-*)
}

export type Orientation = "stack" | "side";

export interface LayoutResult {
  orientation: Orientation;
  foe: Rect; // opponent video panel
  me: Rect; // own video panel
  arena: Rect; // strip between panels (messages, trajectories)
  hudFoe: Rect; // HUD zone of the opponent
  hudMe: Rect; // HUD zone of own player
  compact: boolean;
  vw: number;
  vh: number;
  safe: SafeInsets;
}

/** Max extra cover-crop on one axis to fill the available space better. */
export const MAX_CROP = 0.1;
/** In `side` the opponent panel is on the left, own panel on the right. */
export const FOE_LEFT = true;

const K_MAX = 1 / (1 - MAX_CROP); // aspect multiplier limit
const HYSTERESIS = 1.08; // switch orientation only if >8% more video area

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const saneAspect = (a: number) => (a > 0.2 && a < 5 ? a : 16 / 9);

// minimal HUD reservations
const plateH = (vh: number) => clamp(vh * 0.06, 40, 64);
const spellbarH = (vh: number) => clamp(vh * 0.1, 56, 100);
const arenaGap = (v: number) => clamp(v * 0.04, 24, 48);

/** stack: both panels share width w; displayed heights = w/(a_i*k), k∈[1,K_MAX] crops height. */
function stackSize(W: number, H: number, am: number, af: number) {
  const sumInv = 1 / am + 1 / af;
  const w0 = H / sumInv;
  const w = Math.min(W, w0 * K_MAX);
  const k = clamp(w / w0, 1, K_MAX);
  const hf = w / (af * k);
  const hm = w / (am * k);
  return { w, hf, hm, area: w * (hf + hm) };
}

/** side: both panels share height h; widths = h*a_i*k, k∈[1-MAX_CROP,K_MAX]. */
function sideSize(W: number, H: number, am: number, af: number) {
  const sum = am + af;
  const h = Math.min(H, W / (sum * (1 - MAX_CROP)));
  const k = clamp(W / (h * sum), 1 - MAX_CROP, K_MAX);
  const wf = h * af * k;
  const wm = h * am * k;
  return { h, wf, wm, area: h * (wf + wm) };
}

export function computeLayout(input: LayoutInput, prev?: Orientation): LayoutResult {
  const am = saneAspect(input.meAspect);
  const af = saneAspect(input.foeAspect);
  const ax = input.safe.left;
  const ay = input.safe.top;
  const aw = Math.max(240, input.vw - input.safe.left - input.safe.right);
  const ah = Math.max(240, input.vh - input.safe.top - input.safe.bottom);

  const p = plateH(input.vh);
  const s = spellbarH(input.vh);
  const ar = arenaGap(input.vh);
  const arw = arenaGap(input.vw);

  const st = stackSize(aw, ah - p - s - ar, am, af);
  const sd = sideSize(aw - arw, ah - p - s, am, af);

  const orientation: Orientation = !prev
    ? st.area >= sd.area
      ? "stack"
      : "side"
    : st.area > sd.area * HYSTERESIS
      ? "stack"
      : sd.area > st.area * HYSTERESIS
        ? "side"
        : prev;

  let foe: Rect, me: Rect, arena: Rect, hudFoe: Rect, hudMe: Rect;
  if (orientation === "stack") {
    const { w, hf, hm } = st;
    const extra = Math.max(0, ah - (p + hf + ar + hm + s));
    const top = ay + p + extra / 2;
    const cx = ax + (aw - w) / 2;
    foe = { x: cx, y: top, w, h: hf };
    me = { x: cx, y: top + hf + ar, w, h: hm };
    arena = { x: ax, y: foe.y + hf, w: aw, h: ar };
    hudFoe = { x: ax, y: ay, w: aw, h: top - ay };
    hudMe = { x: ax, y: me.y + hm, w: aw, h: ay + ah - (me.y + hm) };
  } else {
    const { h, wf, wm } = sd;
    const extraX = Math.max(0, aw - (wf + arw + wm));
    const extraY = Math.max(0, ah - (p + h + s));
    const left = ax + extraX / 2;
    const top = ay + p + extraY / 2;
    const xFoe = FOE_LEFT ? left : left + wm + arw;
    const xMe = FOE_LEFT ? left + wf + arw : left;
    const between = left + (FOE_LEFT ? wf : wm);
    foe = { x: xFoe, y: top, w: wf, h };
    me = { x: xMe, y: top, w: wm, h };
    arena = { x: between, y: ay, w: arw, h: ah };
    hudFoe = { x: xFoe, y: ay, w: wf, h: top - ay };
    hudMe = { x: xMe, y: top + h, w: wm, h: ay + ah - top - h };
  }

  const short = Math.min(foe.w, foe.h, me.w, me.h);
  const compact = input.vh < 500 || input.vw < 420 || short < 260;

  return {
    orientation,
    foe,
    me,
    arena,
    hudFoe,
    hudMe,
    compact,
    vw: input.vw,
    vh: input.vh,
    safe: input.safe,
  };
}
