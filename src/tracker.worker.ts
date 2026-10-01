import { createRecognizer, type GestureRecognizer, type MpAssets } from "./mediapipe";

export interface TrackedHand {
  landmarks: { x: number; y: number }[];
  gesture: string;
  score: number;
  hand: string; // "Left" | "Right"
}

export type WorkerIn =
  | { type: "init"; assets: MpAssets; numHands: number }
  | { type: "frame"; bitmap: ImageBitmap; ts: number };

export type WorkerOut =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; ts: number; hands: TrackedHand[] };

let recognizer: GestureRecognizer | null = null;

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      recognizer = await createRecognizer(msg.assets, msg.numHands);
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
    return;
  }
  if (msg.type === "frame" && recognizer) {
    try {
      const res = recognizer.recognizeForVideo(msg.bitmap, msg.ts);
      const hands: TrackedHand[] = res.landmarks.map((lm, i) => {
        const g = res.gestures[i]?.[0];
        const h = res.handedness[i]?.[0];
        return {
          landmarks: lm.map((p) => ({ x: p.x, y: p.y })),
          gesture: g?.categoryName ?? "None",
          score: g?.score ?? 0,
          hand: h?.categoryName ?? "Unknown",
        };
      });
      post({ type: "result", ts: msg.ts, hands });
    } catch (err) {
      post({ type: "error", message: String(err) });
    } finally {
      msg.bitmap.close();
    }
  }
};

function post(msg: WorkerOut, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, { transfer });
}
