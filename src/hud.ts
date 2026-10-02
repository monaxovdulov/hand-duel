import { SPELLS } from "./spells";
import { qrDraw } from "./qr";
import type { GameUi } from "./game";
import type { LayoutResult, Rect } from "./layout";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const GESTURE_EMOJI: Record<string, string> = {
  Closed_Fist: "✊",
  Victory: "✌️",
  ILoveYou: "🤟",
  Thumb_Up: "👍",
  Pointing_Up: "👆",
  Open_Palm: "✋",
};
const PORTAL_EMOJI = "🤲";

const place = (el: HTMLElement, r: Rect) => {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
};

export class Hud implements GameUi {
  /** Wired by main: cooldown lookup (0..1) per spell id. */
  cooldownSource: (id: string) => number = () => 0;
  onRetry: (() => void) | null = null;
  onRematch: (() => void) | null = null;
  onExit: (() => void) | null = null;

  private root = $("hud");
  private plateFoe = $("plate-foe");
  private plateMe = $("plate-me");
  private hudMe = $("hud-me");
  private arena = $("arena");
  private toasts = $("toasts");
  private countdownEl = $("countdown");
  private frameEdge = $("frame-edge");
  private loading = $("loading");
  private loadingText = $("loading-text");
  private retry = $("retry") as HTMLButtonElement;
  private waiting = $("waiting");
  private paused = $("paused");
  private leavePause = $("leave-pause") as HTMLButtonElement;
  private overEl = $("over");
  private overTitle = $("over-title");
  private overHp = $("over-hp");
  private overHint = $("over-hint");
  private rematchBtn = $("rematch") as HTMLButtonElement;
  private rotateHint = $("rotate-hint");
  private fs = $("fs") as HTMLButtonElement;

  private lastMe = 100;
  private lastFoe = 100;
  private lit: string | null = null;
  private edges = new Set<string>();
  private edgeToastAt = 0;
  private spellEls = new Map<string, HTMLElement>();

  constructor() {
    const bar = $("spellbar");
    for (const s of Object.values(SPELLS)) {
      const el = document.createElement("div");
      el.className = "sp";
      el.dataset.id = s.id;
      el.innerHTML = `<div class="ico"><span class="emo">${GESTURE_EMOJI[s.gesture] ?? "❔"}</span><i class="cd"></i></div><span class="nm">${s.name}</span>`;
      bar.appendChild(el);
      this.spellEls.set(s.id, el);
    }
    for (const [id, emoji, name] of [
      ["shield", "✋", "Щит"],
      ["portal", PORTAL_EMOJI, "Портал"],
    ] as const) {
      const el = document.createElement("div");
      el.className = "sp";
      el.dataset.id = id;
      el.innerHTML = `<div class="ico"><span class="emo">${emoji}</span></div><span class="nm">${name}</span>`;
      bar.appendChild(el);
      this.spellEls.set(id, el);
    }

    // lobby gesture table built from SPELLS, no duplicated string
    const parts = Object.values(SPELLS).map(
      (s) => `${GESTURE_EMOJI[s.gesture] ?? "❔"} ${s.name.toLowerCase()}`,
    );
    $("hint").textContent =
      parts.join(" · ") + ` · ${GESTURE_EMOJI.Open_Palm} щит · ${PORTAL_EMOJI} рамка двумя руками — портал`;

    if (!document.fullscreenEnabled) this.fs.style.display = "none";
    this.fs.onclick = () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => {});
    };
    $("copy").onclick = () => {
      if (!navigator.clipboard) {
        this.toast(location.href);
        return;
      }
      void navigator.clipboard
        .writeText(location.href)
        .then(() => this.toast("Скопировано"))
        .catch(() => this.toast(location.href));
    };
    this.retry.onclick = () => this.onRetry?.();
    this.rematchBtn.onclick = () => this.onRematch?.();
    $("exit").onclick = () => this.onExit?.();
    this.leavePause.onclick = () => this.onExit?.();
  }

  /** Position all HUD blocks by the computed layout. */
  applyLayout(r: LayoutResult): void {
    this.root.dataset.orient = r.orientation;
    if (r.compact) this.root.dataset.compact = "";
    else delete this.root.dataset.compact;

    // foe plate hugs the foe panel edge (bottom of its hud zone, centered on the panel)
    const pw = Math.min(r.hudFoe.w, r.compact ? 300 : 340);
    const ph = Math.min(r.hudFoe.h, r.compact ? 34 : 46);
    const px = Math.min(
      Math.max(r.foe.x + r.foe.w / 2 - pw / 2, r.safe.left + 4),
      r.vw - r.safe.right - pw - 4,
    );
    place(this.plateFoe, { x: px, y: r.foe.y - ph, w: pw, h: ph });

    place(this.hudMe, r.hudMe);
    place(this.arena, r.arena);
    place(this.frameEdge, r.me);
    place(this.waiting, r.foe);
    place(this.paused, r.foe);
    place(this.loading, r.me);

    this.fs.style.top = `${r.safe.top + 8}px`;
    this.fs.style.right = `${r.safe.right + 8}px`;

    this.rotateHint.classList.toggle("on", r.vw > r.vh && r.vh < 360);
  }

  show(): void {
    this.root.hidden = false;
  }
  hide(): void {
    this.root.hidden = true;
  }

  // --- GameUi ---

  hpMe(hp: number): void {
    this.setHp(this.plateMe, hp);
    const d = hp - this.lastMe;
    this.lastMe = hp;
    if (d !== 0) this.floater(this.plateMe, d);
  }

  hpFoe(hp: number): void {
    this.setHp(this.plateFoe, hp);
    const d = hp - this.lastFoe;
    this.lastFoe = hp;
    if (d !== 0) this.floater(this.plateFoe, d);
  }

  private setHp(plate: HTMLElement, hp: number): void {
    (plate.querySelector(".hpbar i") as HTMLElement).style.width = `${hp}%`;
    plate.querySelector(".hpnum")!.textContent = `${hp}`;
  }

  private floater(plate: HTMLElement, delta: number): void {
    plate.classList.remove("shake");
    void plate.offsetWidth;
    plate.classList.add("shake");
    const f = document.createElement("b");
    f.className = "float" + (delta > 0 ? " heal" : "");
    f.textContent = delta > 0 ? `+${delta}` : `−${-delta}`;
    plate.appendChild(f);
    setTimeout(() => f.remove(), 900);
  }

  toast(text: string): void {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 2) this.toasts.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 320);
    }, 1500);
  }

  gesture(g: string | null): void {
    this.lit = g;
    for (const [id, el] of this.spellEls) el.classList.toggle("lit", id === g);
  }

  castFx(spellId: string): void {
    const el = this.spellEls.get(spellId);
    if (!el) return;
    el.classList.add("cast");
    setTimeout(() => el.classList.remove("cast"), 300);
  }

  frameEdges(edges: string[]): void {
    const next = new Set(edges);
    if (next.size === this.edges.size && [...next].every((e) => this.edges.has(e))) return;
    this.edges = next;
    for (const e of ["t", "r", "b", "l"]) {
      this.frameEdge.querySelector(`.${e}`)!.classList.toggle("on", next.has(e));
    }
    const now = performance.now();
    if (next.size > 0 && now - this.edgeToastAt > 3000) {
      this.edgeToastAt = now;
      this.toast("Руку в кадр");
    }
  }

  /** Per-frame cooldown rings + ready highlight. Call from rAF. */
  update(): void {
    for (const s of Object.values(SPELLS)) {
      const el = this.spellEls.get(s.id)!;
      const cd = this.cooldownSource(s.id);
      (el.querySelector(".cd") as HTMLElement).style.setProperty("--cd", cd.toFixed(3));
      el.classList.toggle("rdy", this.lit === s.id && cd === 0);
    }
  }

  // --- phase overlays ---

  showLoading(text: string): void {
    this.loadingText.textContent = text;
    this.retry.hidden = true;
    this.loading.querySelector(".spinner")!.removeAttribute("hidden");
    this.loading.hidden = false;
  }
  setLoadingText(text: string): void {
    this.loadingText.textContent = text;
  }
  /** Error state: text + retry button, spinner off. */
  loadingError(text: string): void {
    this.loadingText.textContent = text;
    this.loading.querySelector(".spinner")!.setAttribute("hidden", "");
    this.retry.hidden = false;
    this.loading.hidden = false;
  }
  hideLoading(): void {
    this.loading.hidden = true;
  }

  showWaiting(code: string): void {
    $("wcode").textContent = code;
    qrDraw($("qr") as unknown as HTMLCanvasElement, location.href);
    this.waiting.hidden = false;
  }
  hideWaiting(): void {
    this.waiting.hidden = true;
  }

  setCountdown(text: string): void {
    this.countdownEl.textContent = text;
  }

  showPaused(): void {
    this.leavePause.hidden = true;
    this.paused.hidden = false;
  }
  showPausedExit(): void {
    this.leavePause.hidden = false;
  }
  hidePaused(): void {
    this.paused.hidden = true;
  }

  showOver(win: boolean, hpMe: number, hpFoe: number): void {
    this.overTitle.textContent = win ? "ПОБЕДА" : "ПОРАЖЕНИЕ";
    this.overTitle.style.color = win ? "#7fffb0" : "#ff6a5e";
    this.overHp.textContent = win
      ? `Осталось HP: ${hpMe}`
      : `У соперника осталось: ${hpFoe} HP`;
    this.overHint.textContent = "";
    this.rematchBtn.disabled = false;
    this.rematchBtn.textContent = "Реванш";
    this.overEl.hidden = false;
  }
  rematchWaiting(): void {
    this.rematchBtn.disabled = true;
    this.rematchBtn.textContent = "Ждём соперника…";
  }
  setOverHint(text: string): void {
    this.overHint.textContent = text;
  }
  hideOver(): void {
    this.overEl.hidden = true;
  }
}
