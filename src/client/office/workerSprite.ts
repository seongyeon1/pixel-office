import type { Provider } from '../../shared/contracts';

// Original 48 × 64 pixel artwork. Both SVG portraits and the canvas office use
// these same integer-aligned pixels; no smoothing or external image requests.
export const SPRITE_WIDTH = 48;
export const SPRITE_HEIGHT = 64;
export type PixelRun = readonly [x: number, y: number, width: number, color: string];
const cache = new Map<string, readonly PixelRun[]>();
const hairPalettes = [
  ['#26252f', '#3a3544', '#514957', '#706575', '#94848f'],
  ['#352824', '#543a30', '#77533e', '#a47652', '#cba179'],
  ['#494032', '#75654b', '#a18d69', '#c5b48a', '#e7d9ae'],
  ['#352733', '#623640', '#8e4b4d', '#bc6c61', '#e49a7d'],
  ['#242f38', '#354653', '#4b6371', '#6d8a92', '#a4bec0'],
  ['#332d43', '#544565', '#7c628b', '#a68bae', '#ceb4cd'],
];
const skinPalettes = [
  ['#aa6657', '#d79879', '#edb797', '#ffdab7', '#d9887f'],
  ['#b87969', '#e2a58f', '#f6cbb1', '#ffe4ca', '#e79b96'],
  ['#784b41', '#a56b50', '#c78e68', '#e6b58a', '#be766c'],
  ['#5c3d39', '#85513f', '#ae7454', '#cf9a72', '#ac6260'],
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
  const style = identity === provider ? (provider === 'claude' ? 3 : 1) : seed % 6;
  const hair =
    hairPalettes[
      identity === provider ? (provider === 'claude' ? 1 : 4) : (seed >>> 4) % hairPalettes.length
    ];
  const skin = skinPalettes[identity === provider ? 1 : (seed >>> 8) % skinPalettes.length];
  const glasses = identity === provider ? provider === 'codex' : (seed >>> 12) % 3 === 0;
  const suit =
    provider === 'claude'
      ? ['#653c36', '#985044', '#bf7356', '#e2a47a', '#f6cba0']
      : ['#25394b', '#354e64', '#4d7087', '#7a9fab', '#acc6c8'];
  const ink = '#302c36',
    shirt = '#f3ead8',
    shirtShadow = '#c7c3be';
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
  // Ground shadow, back hair and the small, tailored body silhouette.
  rect(12, 61, 25, 2, '#c7c5bc');
  rect(17, 63, 15, 1, '#deddd5');
  if (style === 3 || style === 2) {
    poly(
      [
        [13, 16],
        [35, 16],
        [38, 28],
        [37, 43],
        [33, 49],
        [28, 46],
        [15, 48],
        [11, 41],
      ],
      hair[0],
    );
    rect(13, 25, 5, 18, hair[1]);
    rect(15, 25, 3, 18, hair[2]);
    rect(33, 23, 3, 19, hair[2]);
    rect(34, 28, 1, 13, hair[3]);
  }
  poly(
    [
      [18, 35],
      [30, 35],
      [34, 38],
      [37, 45],
      [36, 51],
      [32, 53],
      [31, 60],
      [34, 61],
      [34, 63],
      [24, 63],
      [23, 60],
      [21, 63],
      [13, 63],
      [13, 60],
      [16, 59],
      [15, 52],
      [11, 50],
      [11, 44],
      [14, 38],
    ],
    ink,
  );
  rect(17, 51, 7, 9, '#4c4653');
  rect(25, 51, 6, 9, '#3b3947');
  rect(18, 53, 3, 7, '#777281');
  rect(26, 54, 2, 6, '#5a596a');
  rect(14, 60, 9, 2, '#46434c');
  rect(25, 60, 8, 2, '#46434c');
  rect(14, 62, 9, 1, '#ddd6cd');
  rect(25, 62, 8, 1, '#ddd6cd');
  rect(15, 60, 4, 1, '#949096');
  rect(26, 60, 4, 1, '#8c888f');
  poly(
    [
      [18, 37],
      [29, 37],
      [33, 40],
      [34, 51],
      [29, 54],
      [17, 52],
      [14, 48],
      [15, 40],
    ],
    suit[1],
  );
  poly(
    [
      [17, 38],
      [21, 38],
      [21, 51],
      [17, 50],
      [15, 47],
      [15, 41],
    ],
    suit[2],
  );
  poly(
    [
      [29, 38],
      [32, 40],
      [33, 49],
      [29, 52],
      [26, 52],
      [28, 42],
    ],
    suit[2],
  );
  rect(16, 40, 2, 6, suit[3]);
  rect(31, 42, 1, 7, suit[0]);
  rect(17, 49, 4, 1, suit[3]);
  // Shirt, two folded lapels, seam, tiny buttons and a clipped ID badge.
  poly(
    [
      [21, 37],
      [28, 37],
      [27, 48],
      [24, 53],
      [22, 48],
    ],
    shirtShadow,
  );
  poly(
    [
      [21, 37],
      [24, 39],
      [28, 37],
      [26, 46],
      [24, 49],
      [22, 46],
    ],
    shirt,
  );
  poly(
    [
      [18, 38],
      [20, 37],
      [24, 42],
      [20, 41],
      [21, 44],
      [18, 47],
    ],
    suit[4],
  );
  poly(
    [
      [29, 37],
      [31, 39],
      [28, 46],
      [26, 43],
      [28, 41],
      [24, 42],
    ],
    suit[3],
  );
  rect(23, 40, 2, 2, suit[0]);
  poly(
    [
      [23, 42],
      [25, 42],
      [26, 47],
      [24, 49],
      [22, 47],
    ],
    suit[1],
  );
  rect(23, 43, 1, 4, suit[3]);
  rect(24, 50, 1, 1, '#e2c894');
  rect(24, 52, 1, 1, '#e2c894');
  rect(29, 44, 3, 4, '#ebe2cf');
  rect(29, 43, 1, 1, '#c6b07e');
  rect(30, 45, 1, 1, suit[1]);
  rect(29, 47, 3, 1, '#b1b7ab');
  // Sleeves, cuffs and shaded hands.
  poly(
    [
      [13, 40],
      [16, 39],
      [16, 47],
      [14, 49],
      [12, 47],
    ],
    suit[2],
  );
  rect(12, 43, 1, 4, suit[3]);
  poly(
    [
      [33, 39],
      [35, 42],
      [36, 47],
      [33, 49],
      [32, 46],
    ],
    suit[1],
  );
  rect(34, 43, 1, 4, suit[2]);
  rect(12, 47, 3, 2, shirtShadow);
  rect(33, 47, 3, 2, shirt);
  rect(12, 49, 3, 3, skin[0]);
  rect(12, 49, 2, 2, skin[2]);
  rect(33, 49, 3, 3, skin[0]);
  rect(34, 49, 2, 2, skin[2]);
  rect(21, 33, 7, 5, skin[0]);
  rect(22, 34, 5, 4, skin[2]);
  rect(23, 37, 3, 1, skin[3]);
  // Rounded, stepped head outline; subtle ears and jaw shading.
  poly(
    [
      [15, 11],
      [33, 11],
      [36, 16],
      [37, 22],
      [38, 24],
      [37, 29],
      [35, 30],
      [34, 33],
      [30, 36],
      [19, 36],
      [15, 33],
      [13, 29],
      [10, 28],
      [10, 23],
      [12, 22],
      [12, 16],
    ],
    hair[0],
  );
  rect(11, 23, 4, 5, skin[1]);
  rect(12, 24, 2, 2, skin[3]);
  rect(34, 23, 3, 5, skin[1]);
  rect(35, 24, 1, 2, skin[3]);
  poly(
    [
      [16, 13],
      [31, 13],
      [34, 18],
      [34, 29],
      [32, 32],
      [28, 35],
      [20, 35],
      [16, 32],
      [14, 28],
      [14, 19],
    ],
    skin[1],
  );
  poly(
    [
      [18, 15],
      [31, 15],
      [33, 20],
      [32, 30],
      [29, 33],
      [19, 33],
      [16, 30],
      [15, 23],
      [16, 18],
    ],
    skin[2],
  );
  rect(18, 17, 12, 6, skin[3]);
  rect(16, 21, 2, 6, skin[3]);
  rect(18, 23, 13, 6, skin[2]);
  rect(18, 30, 3, 2, skin[3]);
  rect(27, 30, 3, 2, skin[3]);
  rect(22, 33, 5, 1, skin[3]);
  // Eyebrows, white sclera, colored irises, catchlights and eyelashes.
  rect(16, 22, 6, 1, hair[1]);
  rect(27, 22, 6, 1, hair[1]);
  rect(17, 21, 4, 1, hair[2]);
  rect(28, 21, 4, 1, hair[2]);
  for (const x of [16, 27]) {
    rect(x, 24, 6, 1, ink);
    rect(x, 25, 6, 4, '#fcf2e6');
    rect(x + 2, 25, 3, 4, ink);
    rect(x + 2, 27, 2, 2, provider === 'claude' ? '#ad6152' : '#4b8491');
    rect(x + 2, 25, 1, 1, '#fffdf1');
    rect(x + 1, 29, 4, 1, skin[0]);
  }
  rect(15, 24, 1, 2, hair[0]);
  rect(33, 24, 1, 2, hair[0]);
  rect(15, 29, 3, 1, skin[4]);
  rect(31, 29, 3, 1, skin[4]);
  rect(16, 30, 2, 1, skin[4]);
  rect(31, 30, 2, 1, skin[4]);
  rect(24, 28, 1, 2, skin[1]);
  rect(23, 30, 2, 1, skin[0]);
  rect(23, 31, 3, 1, skin[0]);
  rect(24, 32, 2, 1, '#f2b3a1');
  // Hair volume: stair-stepped silhouette and directional clusters, not a flat cap.
  poly(
    [
      [11, 20],
      [9, 17],
      [10, 11],
      [13, 7],
      [18, 4],
      [23, 3],
      [26, 1],
      [29, 1],
      [28, 4],
      [33, 5],
      [37, 9],
      [39, 15],
      [38, 22],
      [35, 25],
      [33, 19],
      [31, 16],
      [27, 15],
      [24, 17],
      [21, 18],
      [20, 15],
      [17, 18],
      [15, 21],
      [14, 27],
      [12, 25],
    ],
    hair[0],
  );
  poly(
    [
      [11, 16],
      [12, 11],
      [15, 8],
      [19, 6],
      [26, 5],
      [32, 7],
      [35, 10],
      [37, 15],
      [36, 20],
      [34, 19],
      [31, 14],
      [27, 13],
      [24, 15],
      [22, 16],
      [20, 13],
      [17, 16],
      [14, 20],
      [13, 24],
      [12, 22],
    ],
    hair[1],
  );
  poly(
    [
      [12, 14],
      [15, 10],
      [21, 7],
      [27, 7],
      [31, 9],
      [28, 10],
      [24, 11],
      [21, 14],
      [19, 12],
      [15, 16],
      [13, 19],
    ],
    hair[2],
  );
  poly(
    [
      [15, 10],
      [19, 8],
      [24, 7],
      [24, 9],
      [20, 10],
      [17, 13],
      [14, 15],
    ],
    hair[3],
  );
  rect(18, 9, 2, 1, hair[4]);
  rect(16, 11, 1, 2, hair[4]);
  rect(14, 14, 1, 2, hair[3]);
  poly(
    [
      [28, 8],
      [32, 10],
      [35, 14],
      [35, 18],
      [33, 16],
      [31, 12],
      [28, 11],
    ],
    hair[2],
  );
  rect(31, 10, 2, 1, hair[3]);
  rect(33, 12, 1, 2, hair[3]);
  rect(36, 16, 1, 3, hair[2]);
  if (style === 0 || style === 5) {
    // Short, tousled fringe, including a few small side curls.
    poly(
      [
        [11, 13],
        [14, 10],
        [18, 11],
        [17, 15],
        [20, 13],
        [23, 14],
        [22, 19],
        [19, 20],
        [18, 17],
        [15, 21],
        [13, 20],
      ],
      hair[1],
    );
    rect(13, 13, 2, 3, hair[3]);
    rect(18, 14, 2, 2, hair[2]);
    rect(20, 16, 1, 2, hair[3]);
    if (style === 5) {
      rect(9, 16, 3, 3, hair[0]);
      rect(10, 16, 2, 2, hair[2]);
      rect(36, 20, 3, 4, hair[0]);
      rect(36, 21, 2, 2, hair[2]);
    }
  }
  if (style === 1) {
    // Swept fringe and an exposed temple.
    poly(
      [
        [17, 9],
        [28, 7],
        [33, 10],
        [30, 13],
        [26, 16],
        [23, 19],
        [20, 21],
        [18, 21],
        [21, 17],
        [23, 13],
      ],
      hair[2],
    );
    poly(
      [
        [20, 10],
        [27, 8],
        [30, 9],
        [26, 11],
        [23, 15],
        [20, 17],
        [22, 12],
      ],
      hair[3],
    );
    rect(26, 9, 2, 1, hair[4]);
    rect(20, 16, 1, 2, hair[4]);
    rect(33, 20, 2, 4, hair[1]);
  }
  if (style === 2 || style === 3) {
    // Soft bob / long locks frame the cheeks without hiding the eyes.
    poly(
      [
        [11, 17],
        [15, 16],
        [14, 29],
        [17, 35],
        [17, style === 3 ? 45 : 36],
        [13, style === 3 ? 43 : 35],
        [11, 30],
      ],
      hair[1],
    );
    poly(
      [
        [35, 16],
        [38, 19],
        [38, 31],
        [35, style === 3 ? 46 : 37],
        [32, style === 3 ? 43 : 35],
        [34, 29],
      ],
      hair[1],
    );
    rect(12, 22, 1, 9, hair[3]);
    rect(14, 31, 1, style === 3 ? 10 : 3, hair[2]);
    rect(35, 24, 1, 10, hair[3]);
    rect(34, 35, 1, style === 3 ? 8 : 1, hair[2]);
    poly(
      [
        [17, 10],
        [24, 8],
        [29, 10],
        [31, 17],
        [27, 18],
        [25, 15],
        [23, 19],
        [19, 20],
        [20, 15],
        [16, 18],
      ],
      hair[2],
    );
    rect(20, 11, 2, 3, hair[3]);
    rect(24, 10, 2, 3, hair[3]);
    rect(28, 12, 1, 3, hair[3]);
    rect(13, 29, 1, 2, '#e8ca85');
    rect(35, 29, 1, 2, '#e8ca85');
  }
  if (style === 4) {
    poly(
      [
        [30, 5],
        [31, 2],
        [36, 1],
        [40, 3],
        [42, 7],
        [40, 11],
        [36, 13],
        [33, 9],
      ],
      hair[0],
    );
    poly(
      [
        [32, 5],
        [34, 3],
        [38, 3],
        [40, 6],
        [39, 9],
        [36, 11],
        [34, 8],
      ],
      hair[2],
    );
    rect(34, 4, 3, 1, hair[3]);
    rect(33, 5, 1, 2, hair[4]);
    rect(36, 10, 3, 1, suit[3]);
    rect(12, 20, 2, 7, hair[2]);
    rect(13, 20, 1, 4, hair[3]);
  }
  if (glasses) {
    // Fine frames leave the eyes and catchlights visible.
    for (const x of [15, 26]) {
      rect(x, 24, 8, 1, '#514b51');
      rect(x, 25, 1, 4, '#514b51');
      rect(x + 7, 25, 1, 4, '#514b51');
      rect(x + 1, 29, 6, 1, '#514b51');
      rect(x + 1, 25, 2, 1, '#b0b9b5');
    }
    rect(23, 25, 3, 1, '#514b51');
    rect(13, 24, 2, 1, '#514b51');
    rect(34, 24, 2, 1, '#514b51');
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
