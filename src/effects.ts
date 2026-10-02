import * as THREE from "three";
import type { Spell } from "./spells";
import { computeLayout, type LayoutResult, type SafeInsets } from "./layout";

export interface Projectile {
  spell: Spell;
  incoming: boolean;
  sprite: THREE.Sprite;
  trail: THREE.Points;
  x: number; // world px (== css px, y up)
  y: number;
  t: number; // elapsed
  life: number; // duration
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromScale: number;
  toScale: number;
  dead: boolean;
}

const TRAIL_LEN = 14;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Crop {
  u0: number;
  v0: number;
  fw: number;
  fh: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Cover-fit crop: which part of the texture fills the region. */
function coverCrop(vw: number, vh: number, reg: Rect): Crop {
  const scale = Math.max(reg.w / vw, reg.h / vh);
  const fw = Math.min(1, reg.w / (vw * scale));
  const fh = Math.min(1, reg.h / (vh * scale));
  return { u0: (1 - fw) / 2, v0: (1 - fh) / 2, fw, fh };
}

function glowTexture(color: string, hard = false): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(hard ? 0.25 : 0.12, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ringTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(120,220,255,0.95)";
  g.lineWidth = 18;
  g.shadowColor = "#4df0ff";
  g.shadowBlur = 30;
  g.beginPath();
  g.arc(128, 128, 96, 0, Math.PI * 2);
  g.stroke();
  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 100);
  grad.addColorStop(0, "rgba(80,200,255,0)");
  grad.addColorStop(1, "rgba(80,200,255,0.25)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(128, 128, 96, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

const PORTAL_VERT = `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// v_uv = normalized screen coords (y down). Each feed occupies its half via crop;
// inside the portal we sample the opponent's frame at the same screen position.
const PORTAL_FRAG = `
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_opp;
uniform float u_oppOn;
uniform vec4 u_myCrop;
uniform vec4 u_oppCrop;
varying vec2 v_uv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 jet(float t) {
  return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0);
}
void main() {
  if (u_oppOn > 0.5) {
    vec3 c = texture2D(u_opp, vec2(u_oppCrop.x + v_uv.x * u_oppCrop.z, u_oppCrop.y + (1.0 - v_uv.y) * u_oppCrop.w)).rgb;
    gl_FragColor = vec4(c, 0.97);
  } else {
    vec3 c = texture2D(u_tex, vec2(1.0 - u_myCrop.x - v_uv.x * u_myCrop.z, u_myCrop.y + (1.0 - v_uv.y) * u_myCrop.w)).rgb;
    gl_FragColor = vec4(jet(luma(c)) * 0.9 + 0.08, 0.92);
  }
}`;

export class Effects {
  readonly scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;
  private video: HTMLVideoElement;
  private me!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private foe!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private meTex: THREE.VideoTexture | null = null;
  private foeTex: THREE.VideoTexture | null = null;
  private meCrop: Crop = { u0: 0, v0: 0, fw: 1, fh: 1 };
  private foeCrop: Crop = { u0: 0, v0: 0, fw: 1, fh: 1 };
  private meRect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private foeRect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  projectiles: Projectile[] = [];
  private bursts: { pts: THREE.Points; vel: Float32Array; life: number; max: number }[] = [];
  private shield!: THREE.Sprite;
  private flash!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private flashDecay = 0;
  private texCache = new Map<string, THREE.Texture>();
  private w = 1;
  private h = 1;
  get width(): number {
    return this.w;
  }
  get height(): number {
    return this.h;
  }
  /** env(safe-area-inset-*) — set by main before resize. */
  safe: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private lay: LayoutResult | null = null;
  get layoutResult(): LayoutResult | null {
    return this.lay;
  }
  /** Fired after every re-layout (resize, opponent stream metadata, rotation). */
  onLayout: ((lay: LayoutResult) => void) | null = null;
  /** Radius multiplier: spell/shield sizes scale with the own panel size. */
  sizeScale = 1;
  shieldActive = false;
  shieldX = 0;
  shieldY = 0;
  shieldRadius = 120;
  /** Portal quad corners in world coords (y-up), or null when closed. */
  portalQuad: { x: number; y: number }[] | null = null;
  private portalMesh!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private portalLine!: THREE.LineLoop;

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.video = video;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);
  }

  /** y in screen coords (top=0) → world y (bottom=0). */
  private wy(py: number): number {
    return this.h - py;
  }

  init(): void {
    this.resize(innerWidth, innerHeight);

    // my camera: bottom half, mirrored selfie view
    const vt = new THREE.VideoTexture(this.video);
    vt.colorSpace = THREE.SRGBColorSpace;
    this.meTex = vt;
    this.me = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: vt }),
    );
    this.me.position.z = -50;
    this.scene.add(this.me);

    // opponent's frame: top half (dark placeholder until stream arrives)
    this.foe = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a0a14 }),
    );
    this.foe.position.z = -50;
    this.scene.add(this.foe);

    this.shield = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringTexture(),
        blending: THREE.AdditiveBlending,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.shield.scale.setScalar(this.shieldRadius * 2);
    this.shield.visible = false;
    this.shield.position.z = 5;
    this.scene.add(this.shield);

    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0, depthTest: false }),
    );
    this.flash.position.z = 20;
    this.scene.add(this.flash);

    const portalGeo = new THREE.BufferGeometry();
    portalGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    portalGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(8), 2));
    portalGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.portalMesh = new THREE.Mesh(
      portalGeo,
      new THREE.ShaderMaterial({
        vertexShader: PORTAL_VERT,
        fragmentShader: PORTAL_FRAG,
        uniforms: {
          u_tex: { value: this.meTex },
          u_opp: { value: null },
          u_oppOn: { value: 0 },
          u_myCrop: { value: new THREE.Vector4() },
          u_oppCrop: { value: new THREE.Vector4() },
        },
        transparent: true,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.portalMesh.visible = false;
    this.scene.add(this.portalMesh);

    this.portalLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(12), 3),
      ),
      new THREE.LineBasicMaterial({
        color: 0x66d9ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthTest: false,
      }),
    );
    this.portalLine.visible = false;
    this.scene.add(this.portalLine);

    this.layout();
  }

  /** Whether the opponent's video texture is attached. */
  get hasOpponent(): boolean {
    return this.foeTex !== null;
  }

  /** Attach the opponent's camera stream — shown in the top half and inside the portal. */
  setOpponentVideo(video: HTMLVideoElement): void {
    if (this.foeTex) this.foeTex.dispose();
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.foeTex = tex;
    this.foe.material.map = tex;
    this.foe.material.color.set(0xffffff);
    this.foe.material.needsUpdate = true;
    this.portalMesh.material.uniforms.u_opp.value = tex;
    this.portalMesh.material.uniforms.u_oppOn.value = 1;
    const relayout = () => this.layout();
    if (video.videoWidth) relayout();
    video.addEventListener("loadedmetadata", relayout);
    video.addEventListener("resize", relayout); // phone rotation changes aspect mid-stream
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    if (this.me) this.layout();
  }

  private layout(): void {
    const w = this.w;
    const h = this.h;
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const fv = this.foeTex?.image as HTMLVideoElement | undefined;
    const foeAspect = fv?.videoWidth ? fv.videoWidth / fv.videoHeight : vw / vh;

    const lay = computeLayout(
      { vw: w, vh: h, meAspect: vw / vh, foeAspect, safe: this.safe },
      this.lay?.orientation,
    );
    this.lay = lay;
    this.meRect = lay.me;
    this.foeRect = lay.foe;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, lay.compact ? 1.5 : 2));

    const place = (mesh: THREE.Mesh<THREE.PlaneGeometry>, r: Rect) => {
      mesh.scale.set(r.w, r.h, 1);
      mesh.position.set(r.x + r.w / 2, this.wy(r.y + r.h / 2), -50);
    };
    place(this.me, this.meRect);
    place(this.foe, this.foeRect);

    this.meCrop = coverCrop(vw, vh, this.meRect);
    const setCrop = (tex: THREE.VideoTexture, c: Crop, mirror: boolean) => {
      tex.repeat.set(mirror ? -c.fw : c.fw, c.fh);
      tex.offset.set(mirror ? 1 - c.u0 : c.u0, c.v0);
    };
    setCrop(this.meTex!, this.meCrop, true);
    if (this.foeTex && fv) {
      this.foeCrop = coverCrop(fv.videoWidth || 640, fv.videoHeight || 480, this.foeRect);
      setCrop(this.foeTex, this.foeCrop, false);
    }
    this.portalMesh.material.uniforms.u_myCrop.value.set(
      this.meCrop.u0, this.meCrop.v0, this.meCrop.fw, this.meCrop.fh,
    );
    this.portalMesh.material.uniforms.u_oppCrop.value.set(
      this.foeCrop.u0, this.foeCrop.v0, this.foeCrop.fw, this.foeCrop.fh,
    );

    // gameplay sizes follow the own panel size, not the raw window
    this.sizeScale = Math.min(lay.me.w, lay.me.h) / 540;
    this.shieldRadius = Math.max(40, 0.14 * Math.min(lay.me.w, lay.me.h));
    this.shield.scale.setScalar(this.shieldRadius * 2);

    this.flash.scale.set(w, h, 1);
    this.flash.position.set(w / 2, this.wy(h / 2), 20);

    this.onLayout?.(lay);
  }

  /** Clamp a screen-coords point into the own panel (with padding). */
  clampMe(x: number, y: number, pad = 8): { x: number; y: number } {
    const r = this.meRect;
    return {
      x: clamp(x, r.x + pad, r.x + r.w - pad),
      y: clamp(y, r.y + pad, r.y + r.h - pad),
    };
  }

  /**
   * Normalized camera coords (raw camera space, y down) → screen px in my half,
   * applying the same cover-crop + mirror as the video feed.
   */
  camToScreen(nx: number, ny: number): { x: number; y: number } {
    const c = this.meCrop;
    const r = this.meRect;
    // mirror: raw-left (nx=0) maps to the right edge of the crop window
    const sx = (1 - c.u0 - nx) / c.fw;
    const sy = (1 - c.v0 - ny) / c.fh;
    return { x: r.x + sx * r.w, y: r.y + sy * r.h };
  }

  /** quadScreen: 4 corners in screen px (y down), or null to close the portal. */
  setPortal(quadScreen: { x: number; y: number }[] | null): void {
    this.portalMesh.visible = this.portalLine.visible = quadScreen !== null;
    if (!quadScreen) {
      this.portalQuad = null;
      return;
    }
    const pos = this.portalMesh.geometry.attributes.position;
    const uv = this.portalMesh.geometry.attributes.uv;
    const line = this.portalLine.geometry.attributes.position;
    this.portalQuad = quadScreen.map((p) => ({ x: p.x, y: this.wy(p.y) }));
    quadScreen.forEach((p, i) => {
      pos.setXYZ(i, p.x, this.wy(p.y), 8);
      uv.setXY(i, p.x / this.w, p.y / this.h);
      line.setXYZ(i, p.x, this.wy(p.y), 9);
    });
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    line.needsUpdate = true;
  }

  /** Is a world-coords point inside the portal quad? */
  portalContains(x: number, y: number): boolean {
    const q = this.portalQuad;
    if (!q) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cross !== 0) {
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  }

  private texFor(spell: Spell): THREE.Texture {
    let t = this.texCache.get(spell.id);
    if (!t) {
      t = glowTexture(css(spell.color));
      this.texCache.set(spell.id, t);
    }
    return t;
  }

  private spawn(spell: Spell, opts: Partial<Projectile>): Projectile {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.texFor(spell),
        blending: THREE.AdditiveBlending,
        depthTest: false,
        transparent: true,
      }),
    );
    sprite.position.z = 10;
    this.scene.add(sprite);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_LEN * 3), 3));
    const trail = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: this.texFor(spell),
        color: spell.color,
        size: spell.radius * 0.7 * this.sizeScale,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        sizeAttenuation: false,
      }),
    );
    trail.position.z = 9;
    this.scene.add(trail);

    const p: Projectile = {
      spell,
      incoming: false,
      sprite,
      trail,
      x: 0,
      y: 0,
      t: 0,
      life: 1,
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      fromScale: 1,
      toScale: 1,
      dead: false,
      ...opts,
    };
    p.x = p.fromX;
    p.y = p.fromY;
    this.projectiles.push(p);
    return p;
  }

  private exits = new Map<string, { x: number; y: number }>();

  /**
   * Point where the projectile of a given spell left the own panel, in world coords.
   * Uses the stored exit of the last cast; falls back to the deterministic edge point
   * derived from the normalized cast position nx (exact in stack, centered in side).
   */
  outgoingExitPoint(spellId: string, nx: number): { x: number; y: number } {
    const stored = this.exits.get(spellId);
    if (stored) return stored;
    const r = this.meRect;
    const cx = r.x + r.w / 2;
    if (this.lay?.orientation === "side") {
      return { x: r.x - 6, y: this.wy(r.y + r.h / 2) };
    }
    const px = this.camToScreen(1 - nx, 0).x;
    return { x: cx + (px - cx) * 0.4, y: this.wy(r.y - 6) };
  }

  /** Own cast: from the hand toward the panel edge facing the opponent, shrinking away. px = screen coords. */
  spawnOutgoing(spell: Spell, px: number, py: number): void {
    const r = this.meRect;
    const c = this.clampMe(px, py, 8);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const t =
      this.lay?.orientation === "side"
        ? { x: r.x - 6, y: cy + (c.y - cy) * 0.4 }
        : { x: cx + (c.x - cx) * 0.4, y: r.y - 6 };
    this.exits.set(spell.id, { x: t.x, y: this.wy(t.y) });
    this.spawn(spell, {
      fromX: c.x,
      fromY: this.wy(c.y),
      toX: t.x,
      toY: this.wy(t.y),
      life: 0.55,
      fromScale: 1.6,
      toScale: 0.45,
    });
  }

  /**
   * Opponent's cast arriving: grows out of their panel edge facing us, toward the viewer.
   * nx = position along that edge (horizontal in stack, vertical in side); already mirrored.
   */
  spawnIncoming(spell: Spell, nx: number): Projectile {
    const f = this.foeRect;
    const m = this.meRect;
    let fromX: number, fromY: number, toX: number, toY: number;
    if (this.lay?.orientation === "side") {
      fromX = f.x + f.w - 4;
      fromY = f.y + nx * f.h;
      toX = m.x + m.w * 0.85;
      toY = clamp(fromY + (Math.random() - 0.5) * m.h * 0.12, m.y + 8, m.y + m.h - 8);
    } else {
      fromX = f.x + nx * f.w;
      fromY = f.y + f.h - 4;
      toX = clamp(fromX + (Math.random() - 0.5) * m.w * 0.12, m.x + 8, m.x + m.w - 8);
      toY = m.y + m.h * 0.85;
    }
    return this.spawn(spell, {
      incoming: true,
      fromX,
      fromY: this.wy(fromY),
      toX,
      toY: this.wy(toY),
      life: spell.flightTime,
      fromScale: 0.5,
      toScale: 2.4,
    });
  }

  clearProjectiles(): void {
    for (const p of this.projectiles) {
      this.scene.remove(p.sprite, p.trail);
      p.sprite.material.dispose();
      p.trail.geometry.dispose();
    }
    this.projectiles = [];
  }

  burst(xWorld: number, yWorld: number, color: number, count = 40): void {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = xWorld;
      pos[i * 3 + 1] = yWorld;
      const a = Math.random() * Math.PI * 2;
      const v = 150 + Math.random() * 450;
      vel[i * 2] = Math.cos(a) * v;
      vel[i * 2 + 1] = Math.sin(a) * v;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color,
        size: 10,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        sizeAttenuation: false,
        map: this.texCache.get("fireball") ?? glowTexture("#ffffff", true),
      }),
    );
    pts.position.z = 15;
    this.scene.add(pts);
    this.bursts.push({ pts, vel, life: 0.55, max: 0.55 });
  }

  hitFlash(): void {
    this.flash.material.opacity = 0.55;
    this.flashDecay = 2.4;
  }

  healPulse(): void {
    this.flash.material.color.set(0x22ff66);
    this.flash.material.opacity = 0.3;
    this.flashDecay = 3;
    setTimeout(() => this.flash.material.color.set(0xff2200), 300);
  }

  /** @returns projectiles that reached their target this frame */
  update(dt: number, onIncomingImpact: (p: Projectile) => void): void {
    this.shield.visible = this.shieldActive;
    if (this.shieldActive) {
      this.shield.position.x += (this.shieldX - this.shield.position.x) * 0.4;
      this.shield.position.y += (this.wy(this.shieldY) - this.shield.position.y) * 0.4;
    }

    for (const p of this.projectiles) {
      p.t += dt;
      const k = Math.min(p.t / p.life, 1);
      const ease = p.incoming ? k * k * 0.4 + k * 0.6 : k;
      p.x = p.fromX + (p.toX - p.fromX) * ease;
      p.y = p.fromY + (p.toY - p.fromY) * ease;
      const s = p.fromScale + (p.toScale - p.fromScale) * ease;
      const size = p.spell.radius * 2 * s * this.sizeScale;
      p.sprite.scale.set(size, size, 1);
      p.sprite.position.set(p.x, p.y, 10);

      const arr = p.trail.geometry.attributes.position.array as Float32Array;
      for (let i = TRAIL_LEN - 1; i > 0; i--) {
        arr[i * 3] = arr[(i - 1) * 3];
        arr[i * 3 + 1] = arr[(i - 1) * 3 + 1];
        arr[i * 3 + 2] = arr[(i - 1) * 3 + 2];
      }
      arr[0] = p.x;
      arr[1] = p.y;
      arr[2] = 0;
      p.trail.geometry.attributes.position.needsUpdate = true;

      if (k >= 1 && !p.dead) {
        p.dead = true;
        if (p.incoming) onIncomingImpact(p);
      }
    }
    this.projectiles = this.projectiles.filter((p) => {
      if (!p.dead) return true;
      this.scene.remove(p.sprite, p.trail);
      p.sprite.material.dispose();
      p.trail.geometry.dispose();
      return false;
    });

    for (const b of this.bursts) {
      b.life -= dt;
      const arr = b.pts.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < b.vel.length / 2; i++) {
        arr[i * 3] += b.vel[i * 2] * dt;
        arr[i * 3 + 1] += b.vel[i * 2 + 1] * dt;
        b.vel[i * 2 + 1] -= 300 * dt;
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(b.life / b.max, 0);
    }
    this.bursts = this.bursts.filter((b) => {
      if (b.life > 0) return true;
      this.scene.remove(b.pts);
      b.pts.geometry.dispose();
      return false;
    });

    if (this.flashDecay > 0) {
      this.flash.material.opacity = Math.max(0, this.flash.material.opacity - this.flashDecay * dt);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
