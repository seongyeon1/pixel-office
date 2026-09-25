import type { Provider } from '../../shared/contracts';

// Original chibi artwork on a small, shared grid: SVG portraits and Canvas
// characters use the same pixels, including each session's stable appearance.
export const SPRITE_WIDTH = 32;
export const SPRITE_HEIGHT = 40;
export type PixelRun = readonly [x: number, y: number, width: number, color: string];
const cache = new Map<string, readonly PixelRun[]>();
const hairPalettes = [
  ['#d99a32', '#f5bf3d', '#ffd957', '#ffe990'],
  ['#653735', '#94473e', '#af5947', '#ce7958'],
  ['#252746', '#34375f', '#494e7b', '#666c94'],
  ['#744454', '#ac6474', '#d38795', '#efb0b3'],
];
const skinPalettes = [
  ['#d89170', '#ffd0a1', '#ffe1b9', '#f39988'],
  ['#b96d50', '#eaa077', '#ffc498', '#dc8073'],
  ['#814b3c', '#be7957', '#d9946b', '#bd6660'],
  ['#593a36', '#87513f', '#a36b50', '#aa5b59'],
];
function seedFor(identity: string) {
  let seed = 2166136261;
  for (const char of identity) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}
export function workerSprite(provider: Provider, identity: string = provider): readonly PixelRun[] {
  const key = `${provider}:${identity}`;
  const saved = cache.get(key);
  if (saved) return saved;
  const seed = seedFor(identity);
  const isDefault = identity === provider;
  const style = isDefault ? (provider === 'claude' ? 0 : 1) : seed % 4;
  const hair =
    hairPalettes[isDefault ? (provider === 'claude' ? 1 : 2) : (seed >>> 4) % hairPalettes.length];
  const skin = skinPalettes[isDefault ? 0 : (seed >>> 8) % skinPalettes.length];
  const outfit =
    provider === 'claude' ? ['#ad4550', '#e66b62', '#ff9380'] : ['#345887', '#578bc4', '#8ab5df'];
  const longHair = style === 0 || style === 2;
  const dress = style === 0;
  const pixels = Array<string>(SPRITE_WIDTH * SPRITE_HEIGHT).fill('');
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let j = Math.max(0, y); j < Math.min(SPRITE_HEIGHT, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(SPRITE_WIDTH, x + w); i++)
        pixels[j * SPRITE_WIDTH + i] = color;
  };
  const poly = (points: number[][], color: string) => {
    const top = Math.max(0, Math.min(...points.map((p) => p[1])));
    const bottom = Math.min(SPRITE_HEIGHT, Math.max(...points.map((p) => p[1])));
    for (let y = top; y < bottom; y++) {
      const intersections: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length],
          scan = y + 0.5;
        if ((a[1] <= scan && b[1] > scan) || (b[1] <= scan && a[1] > scan))
          intersections.push(a[0] + ((scan - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i < intersections.length; i += 2) {
        const x = Math.ceil(intersections[i] - 0.5),
          end = Math.ceil(intersections[i + 1] - 0.5);
        rect(x, y, end - x, 1, color);
      }
    }
  };

  // Soft stepped hair silhouette, with only a few broad patches of shading.
  if (longHair) {
    rect(4, 12, 22, 18, hair[0]);
    rect(5, 16, 4, 15, hair[1]);
    rect(6, 17, 2, 12, hair[2]);
    rect(25, 15, 3, 15, hair[1]);
  }
  // Tiny legs, socks and sneakers. Keep the face much larger than the torso.
  rect(12, 32, 4, 5, skin[1]);
  rect(20, 32, 4, 5, skin[1]);
  rect(12, 35, 4, 2, '#fff0d8');
  rect(20, 35, 4, 2, '#fff0d8');
  rect(11, 37, 6, 2, outfit[0]);
  rect(20, 37, 6, 2, outfit[0]);
  rect(12, 37, 2, 1, outfit[2]);
  rect(21, 37, 2, 1, outfit[2]);
  if (!dress) {
    rect(11, 31, 14, 3, '#40465c');
    rect(17, 33, 2, 1, '#f3ede2');
    rect(12, 31, 5, 1, '#66718b');
  }
  poly(
    [
      [12, 24],
      [23, 24],
      [27, 28],
      [25, 31],
      [24, 33],
      [10, 33],
      [9, 28],
    ],
    outfit[0],
  );
  poly(
    [
      [13, 25],
      [23, 25],
      [25, 29],
      [23, 32],
      [11, 32],
      [11, 28],
    ],
    outfit[1],
  );
  rect(12, 26, 3, 2, outfit[2]);
  if (dress) {
    poly(
      [
        [12, 29],
        [23, 29],
        [26, 35],
        [9, 35],
      ],
      outfit[0],
    );
    poly(
      [
        [13, 29],
        [22, 29],
        [24, 34],
        [11, 34],
      ],
      outfit[1],
    );
    rect(12, 31, 2, 3, outfit[2]);
  } else {
    rect(12, 29, 12, 2, '#ffecd4');
  }
  rect(9, 28, 3, 4, skin[0]);
  rect(10, 28, 3, 3, skin[1]);
  rect(25, 28, 3, 4, skin[0]);
  rect(25, 28, 2, 3, skin[1]);
  rect(16, 23, 5, 3, skin[0]);
  rect(17, 24, 4, 2, skin[1]);

  poly(
    [
      [12, 2],
      [22, 2],
      [22, 3],
      [25, 3],
      [25, 5],
      [28, 5],
      [28, 8],
      [30, 8],
      [30, 13],
      [28, 13],
      [28, 22],
      [25, 25],
      [11, 25],
      [7, 22],
      [5, 18],
      [5, 9],
      [7, 9],
      [7, 6],
      [10, 6],
      [10, 3],
      [12, 3],
    ],
    hair[0],
  );
  poly(
    [
      [12, 3],
      [22, 3],
      [22, 4],
      [25, 4],
      [25, 6],
      [27, 6],
      [27, 9],
      [29, 9],
      [29, 12],
      [26, 15],
      [9, 20],
      [6, 18],
      [6, 9],
      [8, 9],
      [8, 6],
      [11, 6],
      [11, 4],
      [12, 4],
    ],
    hair[1],
  );
  // Rounded cheek and a slightly turned face, with no heavy black outline.
  poly(
    [
      [12, 12],
      [26, 12],
      [27, 15],
      [27, 22],
      [25, 24],
      [14, 24],
      [11, 22],
      [10, 17],
    ],
    skin[0],
  );
  poly(
    [
      [13, 12],
      [26, 12],
      [26, 22],
      [24, 23],
      [14, 23],
      [12, 21],
      [12, 16],
    ],
    skin[1],
  );
  rect(14, 14, 11, 2, skin[2]);
  rect(10, 17, 3, 4, skin[1]);
  rect(10, 18, 1, 2, skin[0]);
  // Two dot eyes, peach cheeks, and a one-pixel smile.
  rect(16, 17, 2, 3, '#352e3c');
  rect(23, 17, 2, 3, '#352e3c');
  rect(14, 20, 3, 1, skin[3]);
  rect(24, 20, 2, 1, skin[3]);
  rect(20, 22, 2, 1, '#a95151');

  // Side-swept fringe in four simple silhouettes.
  poly(
    [
      [10, 7],
      [24, 7],
      [28, 10],
      [29, 13],
      [23, 13],
      [23, 12],
      [20, 14],
      [16, 15],
      [16, 16],
      [12, 17],
      [10, 20],
      [8, 19],
      [8, 12],
    ],
    hair[1],
  );
  poly(
    [
      [11, 6],
      [21, 5],
      [24, 7],
      [20, 9],
      [17, 12],
      [12, 14],
      [9, 16],
      [9, 11],
    ],
    hair[2],
  );
  rect(12, 6, 3, 2, hair[3]);
  rect(10, 9, 2, 2, hair[3]);
  rect(20, 6, 2, 1, hair[3]);
  rect(7, 14, 2, 7, hair[2]);
  if (style === 1) {
    rect(7, 19, 3, 4, hair[1]);
    rect(24, 9, 3, 2, hair[2]);
    rect(27, 11, 3, 1, hair[2]);
  } else if (style === 2) {
    rect(25, 13, 3, 3, hair[1]);
    rect(26, 16, 2, 12, hair[1]);
    rect(26, 18, 1, 8, hair[2]);
    rect(9, 13, 2, 13, hair[1]);
  } else if (style === 3) {
    rect(16, 1, 5, 2, hair[1]);
    rect(17, 1, 2, 1, hair[2]);
    rect(20, 11, 3, 4, hair[1]);
    rect(14, 13, 3, 3, hair[1]);
  }

  const runs: PixelRun[] = [];
  for (let y = 0; y < SPRITE_HEIGHT; y++)
    for (let x = 0; x < SPRITE_WIDTH;) {
      const color = pixels[y * SPRITE_WIDTH + x];
      let end = x + 1;
      while (end < SPRITE_WIDTH && pixels[y * SPRITE_WIDTH + end] === color) end++;
      if (color) runs.push([x, y, end - x, color]);
      x = end;
    }
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, runs);
  return runs;
}
