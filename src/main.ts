import { Effects } from "./effects";
import { Game } from "./game";
import { Session } from "./net";
import { Tracker, openCamera } from "./tracker";
import { mediapipeAssets } from "./mediapipe";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const video = $("video") as unknown as HTMLVideoElement;
const canvas = $("gl") as unknown as HTMLCanvasElement;
const statusEl = $("status");
const spellEl = $("spell");
const koEl = $("ko");
const hpMeBar = $("hp-me").querySelector(".bar") as HTMLElement;
const hpFoeBar = $("hp-foe").querySelector(".bar") as HTMLElement;

const setStatus = (t: string) => (statusEl.textContent = t);

// --- join UI ---

const roomInput = $("room") as unknown as HTMLInputElement;
const params = new URLSearchParams(location.search);
if (params.get("room")) roomInput.value = params.get("room")!;

$("create").onclick = () => {
  const code = Math.random().toString(36).slice(2, 8);
  roomInput.value = code;
  history.replaceState(null, "", `?room=${code}`);
};

$("go").onclick = () => {
  const code = roomInput.value.trim().toLowerCase();
  if (!code) {
    roomInput.focus();
    return;
  }
  $("join").style.display = "none";
  history.replaceState(null, "", `?room=${code}`);
  start(code).catch((err) => {
    console.error(err);
    setStatus(`Ошибка: ${err.message ?? err}`);
    $("join").style.display = "flex";
  });
};

// --- boot ---

async function start(code: string): Promise<void> {
  const mobile = matchMedia("(pointer: coarse)").matches;
  setStatus("Открываю камеру…");

  const fx = new Effects(canvas, video);
  await openCamera(video, mobile);
  fx.init();
  addEventListener("resize", () => fx.resize(innerWidth, innerHeight));

  const ui = {
    hpMe: (hp: number) => (hpMeBar.style.width = `${hp}%`),
    hpFoe: (hp: number) => (hpFoeBar.style.width = `${hp}%`),
    status: setStatus,
    spellLabel: (t: string) => {
      spellEl.textContent = t;
      setTimeout(() => {
        if (spellEl.textContent === t) spellEl.textContent = "";
      }, 1200);
    },
    ko: (t: string) => {
      koEl.textContent = t;
      koEl.style.display = "flex";
    },
  };

  setStatus(`Комната «${code}» — жду соперника…`);
  let gameRef: Game;

  const net = new Session(code, {
    onPeerJoin: (id) => setStatus(`Соперник подключился (${id.slice(0, 6)}) — файт!`),
    onPeerLeave: () => setStatus("Соперник отключился — жду…"),
    onCast: (msg) => gameRef.onRemoteCast(msg.s, msg.x),
    onBlocked: (spellId) => gameRef.onRemoteBlocked(spellId),
    onHp: (hp) => gameRef.onRemoteHp(hp),
    onKo: () => gameRef.onRemoteKo(),
    onPeerStream: (stream) => {
      const remote = document.createElement("video");
      remote.muted = true;
      remote.playsInline = true;
      remote.autoplay = true;
      remote.srcObject = stream;
      void remote.play().catch((err) => console.warn("remote video play failed", err));
      fx.setOpponentVideo(remote);
      setStatus("Соперник на связи — файт!");
    },
  });
  if (video.srcObject instanceof MediaStream) net.streamVideo(video.srcObject);

  gameRef = new Game(fx, net, ui);

  const tracker = new Tracker(
    video,
    {
      onResult: (hands) => gameRef.onHands(hands),
      onStatus: setStatus,
      onError: (err) => setStatus(`Трекер: ${err.message}`),
    },
    mediapipeAssets(),
  );
  await tracker.start();

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    gameRef.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
