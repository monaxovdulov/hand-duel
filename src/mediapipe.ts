// Minimal typings + loader for the vendored MediaPipe vision bundle
// (public/vendor/mediapipe/vision_bundle.mjs — @mediapipe/tasks-vision@1.0.1)

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface RecognizedGesture {
  categoryName: string;
  score: number;
}

export interface GestureResult {
  landmarks: Landmark[][];
  worldLandmarks: Landmark[][];
  handedness: { categoryName: string; score: number }[][];
  gestures: RecognizedGesture[][];
}

export interface GestureRecognizer {
  recognizeForVideo(frame: TexImageSource, timestampMs: number): GestureResult;
  close(): void;
}

interface FilesetResolver {
  forVisionTasks(basePath: string): Promise<unknown>;
}

interface GestureRecognizerCtor {
  createFromOptions(
    fileset: unknown,
    options: {
      baseOptions: { modelAssetPath: string; delegate: "GPU" | "CPU" };
      runningMode: "VIDEO" | "IMAGE";
      numHands: number;
    },
  ): Promise<GestureRecognizer>;
}

interface VisionBundle {
  FilesetResolver: FilesetResolver;
  GestureRecognizer: GestureRecognizerCtor;
}

/** Absolute URLs for mediapipe assets — resolved against the page (workers can't use relative paths). */
export interface MpAssets {
  bundleUrl: string;
  wasmRoot: string;
  modelUrl: string;
}

export function mediapipeAssets(): MpAssets {
  const base = document.baseURI;
  return {
    bundleUrl: new URL("vendor/mediapipe/vision_bundle.mjs", base).href,
    wasmRoot: new URL("vendor/mediapipe/wasm", base).href,
    modelUrl: new URL("models/gesture_recognizer.task", base).href,
  };
}

let bundlePromise: Promise<VisionBundle> | null = null;
let bundleUrl = "";

export function loadBundle(url: string): Promise<VisionBundle> {
  if (bundlePromise && url === bundleUrl) return bundlePromise;
  bundleUrl = url;
  bundlePromise = import(/* @vite-ignore */ url) as Promise<VisionBundle>;
  return bundlePromise;
}

export async function createRecognizer(assets: MpAssets, numHands = 2): Promise<GestureRecognizer> {
  const { FilesetResolver, GestureRecognizer } = await loadBundle(assets.bundleUrl);
  const fileset = await FilesetResolver.forVisionTasks(assets.wasmRoot);
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: assets.modelUrl, delegate },
    runningMode: "VIDEO" as const,
    numHands,
  });
  try {
    return await GestureRecognizer.createFromOptions(fileset, opts("GPU"));
  } catch {
    return GestureRecognizer.createFromOptions(fileset, opts("CPU"));
  }
}
