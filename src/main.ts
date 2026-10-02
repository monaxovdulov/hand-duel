import { Effects } from "./effects";
import { Game } from "./game";
import { Session } from "./net";
import { Tracker, openCamera } from "./tracker";
import { mediapipeAssets } from "./mediapipe";
import { Hud } from "./hud";
import type { SafeInsets } from "./layout";

type Phase = "lobby" | "loading" | "waiting" | "fight" | "over";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const video = $("video") as unknown as HTMLVideoElement;
const canvas = $("gl") as unknown as HTMLCanvasElement;
const hud = new Hud();

// safe-area probe (env() needs viewport-fit=cover, already in the meta tag)
const safeProbe = document.createElement("div");
safeProbe.style.cssText =
  "position:fixed;visibility:hidden;pointer-events:none;" +
  "padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);" +
  "padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)";
document.body.appendChild(safeProbe);
const readSafe = (): SafeInsets => {
  const cs = getComputedStyle(safeProbe);
  const n = (v: string) => parseFloat(v) || 0;
  return {
    top: n(cs.paddingTop),
    right: n(cs.paddingRight),
    bottom: n(cs.paddingBottom),
    left: n(cs.paddingLeft),
  };
};

// --- join UI ---

const roomInput = $("room") as unknown as HTMLInputElement;
const params = new URLSearchParams(location.search);
if (params.get("room")) roomInput.value = params.get("room")!;

$("create").onclick = () => {
  const code = Math.random().toString(36).slice(2, 8);
  roomInput.value = code;
  history.replaceState(null, "", `?room=${code}`);
};

let phase: Phase = "lobby";

$("go").onclick = () => {
  const code = roomInput.value.trim().toLowerCase();
  if (!code) {
    roomInput.focus();
    return;
  }
  $("join").hidden = true;
  history.replaceState(null, "", `?room=${code}`);
  start(code).catch((err) => {
    console.error(err);
    hud.loadingError(`Ошибка: ${err.message ?? err}`);
    hud.onRetry = () => location.reload();
  });
};

// --- boot ---

async function start(code: string): Promise<void> {
  phase = "loading";
  hud.show();
  hud.showLoading("Камера…");

  const mobile = matchMedia("(pointer: coarse)").matches;
  const fx = new Effects(canvas, video);

  // camera step is retryable (loading overlay shows the error + retry button)
  for (;;) {
    try {
      await openCamera(video, mobile);
      break;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      hud.loadingError(msg);
      await new Promise<void>((resolve) => (hud.onRetry = resolve));
      hud.showLoading("Камера…");
    }
  }
  hud.onRetry = null;
  fx.init();
  fx.onLayout = (lay) => hud.applyLayout(lay);

  const applyViewport = () => {
    const w = Math.round(visualViewport?.width ?? innerWidth);
    const h = Math.round(visualViewport?.height ?? innerHeight);
    fx.safe = readSafe();
    fx.resize(w, h);
  };
  addEventListener("resize", applyViewport);
  visualViewport?.addEventListener("resize", applyViewport);
  addEventListener("orientationchange", () => setTimeout(applyViewport, 60));
  applyViewport();

  let myRematch = false;
  let foeRematch = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeLock: { release(): Promise<void> } | null = null;
  const acquireWake = () => {
    void (navigator as { wakeLock?: { request(t: string): Promise<typeof wakeLock> } }).wakeLock
      ?.request("screen")
      .then((l) => (wakeLock = l))
      .catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && phase === "fight") acquireWake();
  });

  const gameRef: { game: Game | null } = { game: null };

  const countdown = async () => {
    if (!gameRef.game) return;
    gameRef.game.locked = true;
    for (const t of ["3", "2", "1", "БОЙ!"]) {
      hud.setCountdown(t);
      await delay(650);
    }
    hud.setCountdown("");
    gameRef.game.locked = false;
  };

  const beginFight = async () => {
    if (!gameRef.game) return;
    phase = "fight";
    hud.hideWaiting();
    hud.hidePaused();
    gameRef.game.reset(); // clear training casts/hp drift from the waiting phase
    gameRef.game.armed = false;
    await countdown();
    if (phase !== "fight") return;
    gameRef.game.armed = true;
    acquireWake();
  };

  const doRematch = async () => {
    myRematch = foeRematch = false;
    hud.hideOver();
    await beginFight();
  };

  const net = new Session(code, {
    onPeerJoin: () => {
      hud.toast("Соперник подключился");
    },
    onPeerLeave: () => {
      foeRematch = false;
      if (phase === "fight") {
        hud.showPaused();
        pauseTimer = setTimeout(() => hud.showPausedExit(), 20000);
      } else if (phase === "over") {
        hud.toast("Соперник отключился");
      }
    },
    onCast: (msg) => gameRef.game?.onRemoteCast(msg.s, msg.x),
    onBlocked: (spellId) => gameRef.game?.onRemoteBlocked(spellId),
    onHp: (hp) => gameRef.game?.onRemoteHp(hp),
    onKo: () => gameRef.game?.onRemoteKo(),
    onRematch: () => {
      if (phase !== "over") {
        foeRematch = true;
        return;
      }
      if (myRematch) void doRematch();
      else {
        foeRematch = true;
        hud.setOverHint("Соперник хочет реванш");
      }
    },
    onPeerStream: (stream) => {
      const remote = document.createElement("video");
      remote.muted = true;
      remote.playsInline = true;
      remote.autoplay = true;
      remote.srcObject = stream;
      void remote.play().catch((err) => console.warn("remote video play failed", err));
      fx.setOpponentVideo(remote);
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      if (phase === "waiting") void beginFight();
      else if (phase === "fight") hud.hidePaused();
    },
  });

  hud.onRematch = () => {
    if (phase !== "over" || myRematch) return;
    myRematch = true;
    net.sendRematch();
    if (foeRematch) void doRematch();
    else hud.rematchWaiting();
  };
  hud.onExit = () => {
    net.leave();
    tracker.stop();
    if (video.srcObject instanceof MediaStream)
      for (const t of video.srcObject.getTracks()) t.stop();
    location.href = location.pathname;
  };

  if (video.srcObject instanceof MediaStream) net.streamVideo(video.srcObject);

  hud.showLoading("Модель…");
  const tracker = new Tracker(
    video,
    {
      onResult: (hands) => gameRef.game?.onHands(hands),
      onStatus: (t) => (phase === "loading" ? hud.setLoadingText(t) : hud.toast(t)),
      onError: (err) => hud.toast(`Трекер: ${err.message}`),
    },
    mediapipeAssets(),
  );
  await tracker.start();

  gameRef.game = new Game(fx, net, hud);
  hud.cooldownSource = (id) => gameRef.game?.cooldownLeft(id) ?? 0;

  hud.hideLoading();
  hud.showWaiting(code);
  phase = "waiting";
  if (fx.hasOpponent) void beginFight(); // stream arrived during model load

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    gameRef.game?.update(dt);
    hud.update();
    if (phase === "fight" && gameRef.game?.result) {
      phase = "over";
      hud.hidePaused();
      if (pauseTimer) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
      }
      hud.showOver(
        gameRef.game.result === "win",
        gameRef.game.hpMe,
        gameRef.game.hpFoe,
      );
      if (foeRematch) hud.setOverHint("Соперник хочет реванш");
      void wakeLock?.release();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
