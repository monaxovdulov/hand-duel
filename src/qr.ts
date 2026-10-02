/** Minimal QR encoder: byte mode, ECC level L, versions 1–5 (single block, no interleaving). */

const DATA_CW = [19, 34, 55, 80, 108]; // data codewords for L, v1..v5
const ECC_CW = [7, 10, 15, 20, 26];
const ALIGN = [0, 18, 22, 26, 30]; // alignment center for v2..v5

// GF(256) tables, primitive poly 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsEcc(data: number[], nEcc: number): number[] {
  let gen = [1];
  for (let i = 0; i < nEcc; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(nEcc).fill(0);
  for (const d of data) {
    const f = d ^ rem.shift()!;
    for (let i = 0; i < nEcc; i++) rem[i] ^= gmul(gen[i + 1], f);
  }
  return rem;
}

// format info words for ECL=L, mask 0..7 (15-bit BCH, already XORed with 0x5412)
const FMT = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

/** Returns module matrix (true = dark) or null if text doesn't fit v5-L. */
export function qrMatrix(text: string): boolean[][] | null {
  const data = new TextEncoder().encode(text);
  let v = 0;
  for (let i = 0; i < 5; i++)
    if (data.length <= DATA_CW[i] - 2) {
      v = i + 1;
      break;
    }
  if (!v) return null;

  const size = 17 + 4 * v;
  const cap = DATA_CW[v - 1];

  // bit stream: byte mode header + data + terminator + pad
  const bits: number[] = [];
  const push = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, 8);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let i = cw.length, pad = 0; i < cap; i++, pad ^= 1) cw.push(pad ? 0x11 : 0xec);
  const full = cw.concat(rsEcc(cw, ECC_CW[v - 1]));
  const stream = full.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));

  const build = (mask: number) => {
    const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x: number, y: number, d: boolean, f = true) => {
      m[y][x] = d;
      fn[y][x] = f;
    };
    const finder = (fx: number, fy: number) => {
      for (let dy = -1; dy <= 7; dy++)
        for (let dx = -1; dx <= 7; dx++) {
          const x = fx + dx;
          const y = fy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const sep = dx === -1 || dx === 7 || dy === -1 || dy === 7;
          const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          set(x, y, !sep && (d === 3 || d <= 1));
        }
    };
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);
    for (let i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }
    if (v >= 2) {
      const c = ALIGN[v - 1];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    set(8, size - 8, true); // dark module
    // reserve format cells
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        fn[8][i] = true;
        fn[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      fn[8][size - 1 - i] = true;
      fn[size - 1 - i][8] = true;
    }

    let bit = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? size - 1 - vert : vert;
          if (fn[y][x]) continue;
          let d = (stream[bit++] ?? 0) === 1;
          if (maskOn(mask, x, y)) d = !d;
          m[y][x] = d;
        }
      }
    }
    // format info
    const fmt = FMT[mask];
    for (let i = 0; i < 15; i++) {
      const d = ((fmt >> i) & 1) === 1;
      if (i < 6) set(8, i, d);
      else if (i === 6) set(8, 7, d);
      else if (i === 7) set(8, 8, d);
      else if (i === 8) set(7, 8, d);
      else set(14 - i, 8, d);
      if (i < 8) m[size - 1 - i][8] = d;
      else m[8][size - 15 + i] = d;
    }
    return m;
  };

  const maskOn = (mask: number, x: number, y: number): boolean => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };

  const penalty = (m: boolean[][]): number => {
    let p = 0;
    for (let i = 0; i < size; i++) {
      const col = m.map((r) => r[i]);
      for (const a of [m[i], col]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (a[j] === a[j - 1]) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
        if (run >= 5) p += run - 2;
      }
    }
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };

  let best: boolean[][] | null = null;
  let bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(mask);
    const p = penalty(m);
    if (p < bestP) {
      bestP = p;
      best = m;
    }
  }
  return best;
}

/** Draw the matrix onto a canvas with a quiet zone. Returns false if it didn't fit. */
export function qrDraw(canvas: HTMLCanvasElement, text: string): boolean {
  const m = qrMatrix(text);
  if (!m) {
    canvas.style.display = "none";
    return false;
  }
  const size = m.length;
  const quiet = 4;
  const px = 4;
  canvas.width = canvas.height = (size + quiet * 2) * px;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000";
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (m[y][x]) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
  canvas.style.display = "";
  return true;
}
