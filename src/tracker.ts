import type { TrackedHand, WorkerIn, WorkerOut } from "./tracker.worker";
import { createRecognizer, type GestureRecognizer, type MpAssets } from "./mediapipe";

export interface TrackerEvents {
  onResult(hands: TrackedHand[]): void;
  onStatus(text: string): void;
  onError(err: Error): void;
}

const CAMERA_ERRORS: Record<string, string> = {
  NotFoundError: "Камера не найдена. Проверь подключение и системные настройки приватности.",
  NotAllowedError: "Доступ к камере запрещён. Разреши камеру для сайта и браузера.",
  NotReadableError: "Камера занята другим приложением (Zoom, Meet, OBS…).",
  NotSupportedError: "Нужен HTTPS или localhost — иначе браузер не отдаёт камеру.",
};

export async function openCamera(video: HTMLVideoElement, mobile: boolean): Promise<void> {
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: mobile ? 640 : 1280 },
        height: { ideal: mobile ? 480 : 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    const hint = CAMERA_ERRORS[(err as DOMException).name];
    throw hint ? new Error(hint) : (err as Error);
  }
  await video.play();
}

/** Runs inference in a worker; falls back to the main thread if the worker fails. */
export class Tracker {
  private worker: Worker | null = null;
  private busy = false;
  private stopped = false;
  private mainRecognizer: GestureRecognizer | null = null;
  private lastTs = -1;

  constructor(
    private video: HTMLVideoElement,
    private events: TrackerEvents,
    private assets: MpAssets,
    private numHands = 2,
  ) {}

  async start(): Promise<void> {
    this.events.onStatus("Загружаю модель…");
    try {
      await this.startWorker();
    } catch (err) {
      console.warn("worker tracking failed, falling back to main thread", err);
      this.worker?.terminate();
      this.worker = null;
      this.mainRecognizer = await createRecognizer(this.assets, this.numHands);
    }
    this.events.onStatus("Модель готова");
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.worker?.terminate();
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./tracker.worker.ts", import.meta.url), { type: "module" });
      const timeout = setTimeout(() => reject(new Error("worker init timeout")), 30000);
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          clearTimeout(timeout);
          this.worker = worker;
          resolve();
        } else if (msg.type === "error") {
          this.busy = false;
          if (!this.worker) {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          } else {
            this.events.onError(new Error(msg.message));
          }
        } else if (msg.type === "result") {
          this.busy = false;
          this.events.onResult(msg.hands);
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(e.error ?? new Error(e.message));
      };
      worker.postMessage({ type: "init", assets: this.assets, numHands: this.numHands } satisfies WorkerIn);
    });
  }

  private pump(): void {
    if (this.stopped) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback(() => {
        void this.tick();
        this.pump();
      });
    } else {
      setTimeout(() => {
        void this.tick();
        this.pump();
      }, 33);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.video.readyState < 2 || this.video.currentTime === this.lastTs) return;
    this.lastTs = this.video.currentTime;

    if (this.worker) {
      if (this.busy) return; // drop frame — worker still processing
      this.busy = true;
      try {
        const bitmap = await createImageBitmap(this.video);
        const msg: WorkerIn = { type: "frame", bitmap, ts: performance.now() };
        this.worker.postMessage(msg, { transfer: [bitmap] });
      } catch {
        this.busy = false;
      }
    } else if (this.mainRecognizer) {
      const res = this.mainRecognizer.recognizeForVideo(this.video, performance.now());
      const hands: TrackedHand[] = res.landmarks.map((lm, i) => ({
        landmarks: lm.map((p) => ({ x: p.x, y: p.y })),
        gesture: res.gestures[i]?.[0]?.categoryName ?? "None",
        score: res.gestures[i]?.[0]?.score ?? 0,
        hand: res.handedness[i]?.[0]?.categoryName ?? "Unknown",
      }));
      this.events.onResult(hands);
    }
  }
}
