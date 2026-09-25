import { workerSprite, SPRITE_WIDTH, SPRITE_HEIGHT } from './workerSprite';
import type { Provider, Activity } from '../../shared/contracts';
import { seniorityLabels, activityLabels, type TeamConfig } from '../../shared/contracts';
// Rasterize once at the native pixel grid. Scaling individual rectangles at
// fractional zoom leaves antialiased seams between rows on Canvas.
const workerImages: Partial<Record<Provider, HTMLCanvasElement>> = {};
function workerImage(provider: Provider) {
  if (workerImages[provider]) return workerImages[provider];
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_WIDTH;
  canvas.height = SPRITE_HEIGHT;
  const context = canvas.getContext('2d')!;
  for (const [x, y, width, color] of workerSprite(provider)) {
    context.fillStyle = color;
    context.fillRect(x, y, width, 1);
  }
  workerImages[provider] = canvas;
  return canvas;
}
export const positions: Record<Provider, { x: number; y: number }> = {
  claude: { x: 342, y: 270 },
  codex: { x: 580, y: 270 },
};
export function targetFor(id: Provider, activity: Activity) {
  if (activity === 'reading') return { x: id === 'claude' ? 165 : 222, y: 155 };
  if (activity === 'reviewing') return { x: id === 'claude' ? 718 : 804, y: 416 };
  if (activity === 'executing') return { x: id === 'claude' ? 348 : 580, y: 385 };
  return positions[id];
}
export function drawOffice(
  ctx: CanvasRenderingContext2D,
  agents: Record<Provider, { x: number; y: number; activity: Activity; waiting: boolean }>,
  selected: Provider,
  team: TeamConfig,
  time: number,
  reduced: boolean,
  external = false,
) {
  const r = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const txt = (
    text: string,
    x: number,
    y: number,
    size = 12,
    color = '#626957',
    align: CanvasTextAlign = 'left',
  ) => {
    ctx.fillStyle = color;
    ctx.font = `${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  };
  const plant = (x: number, y: number, scale = 1) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    r(-11, 5, 22, 18, '#b79074');
    r(-14, 2, 28, 7, '#d4b496');
    r(-3, -25, 6, 31, '#6d8060');
    r(-23, -25, 17, 15, '#718867');
    r(-16, -35, 18, 19, '#8ca579');
    r(4, -34, 19, 17, '#749467');
    r(0, -19, 23, 12, '#91ab7d');
    r(-25, -16, 18, 12, '#94ac7e');
    ctx.restore();
  };
  const chair = (x: number, y: number, c = '#899bad') => {
    r(x - 19, y - 14, 38, 29, '#617285');
    r(x - 16, y - 17, 32, 27, c);
    r(x - 19, y + 8, 38, 7, '#536477');
    r(x - 3, y + 15, 6, 10, '#6b7075');
    r(x - 15, y + 23, 30, 4, '#76797a');
  };
  const desk = (x: number, y: number) => {
    r(x - 64, y + 8, 134, 56, '#b9a38e');
    r(x - 68, y, 136, 54, '#ebdbc2');
    r(x - 68, y + 51, 136, 6, '#bea68c');
    r(x - 62, y + 57, 8, 26, '#9b8c7b');
    r(x + 50, y + 57, 8, 26, '#9b8c7b');
    r(x - 25, y - 17, 53, 33, '#4b5763');
    r(x - 20, y - 13, 43, 23, '#b4c7cb');
    r(x - 17, y - 10, 29, 3, '#d5e1d9');
    r(x - 17, y - 3, 18, 2, '#7d9b9b');
    r(x - 17, y + 3, 33, 2, '#95afac');
    r(x - 3, y + 16, 9, 8, '#666f74');
    r(x - 12, y + 22, 26, 4, '#929b9b');
    r(x - 27, y + 32, 50, 13, '#c7c7bd');
    for (let i = 0; i < 5; i++) r(x - 23 + i * 8, y + 35, 5, 2, '#eef0e7');
    r(x + 36, y + 23, 11, 15, '#fbf7e9');
    r(x + 47, y + 26, 5, 8, '#b99b7d');
    r(x - 54, y + 15, 17, 23, '#f8f5ea');
    r(x - 51, y + 19, 10, 2, '#b6c2ac');
  };
  ctx.clearRect(0, 0, 960, 620);
  r(0, 0, 960, 620, '#edf0ed');
  // Floating room silhouette and wall thickness.
  r(61, 82, 840, 494, '#d6dbd5');
  r(54, 74, 840, 494, '#c7cec4');
  r(46, 60, 840, 494, '#abbaa6');
  r(46, 76, 840, 478, '#e5d6bd');
  for (let y = 95; y < 548; y += 27) {
    r(50, y, 832, 1, '#d5c4a9');
    for (let x = 51 + (Math.floor(y / 27) % 2) * 56; x < 880; x += 112)
      r(x, y - 26, 1, 26, '#dac9af');
  }
  // Back wall, glazing, and sunlight.
  r(46, 60, 840, 40, '#becbb6');
  r(46, 95, 840, 7, '#94a58f');
  r(46, 100, 8, 454, '#c4b598');
  r(878, 100, 8, 454, '#c4b598');
  for (const x of [245, 455, 665]) {
    r(x, 28, 157, 65, '#91a6a0');
    r(x + 5, 32, 147, 52, '#d7e8e2');
    r(x + 10, 36, 66, 44, '#b9d2ca');
    r(x + 80, 36, 66, 44, '#c4ddd5');
    r(x + 73, 31, 6, 54, '#f0f1dd');
    r(x - 3, 85, 164, 10, '#ece9d7');
    r(x + 12, 39, 3, 25, '#e5f0e8');
  }
  r(293, 104, 129, 65, '#ecdfc8');
  r(502, 104, 129, 65, '#ecdfc8');
  // Library shelving.
  r(78, 111, 142, 77, '#b19478');
  r(74, 103, 145, 77, '#d5b794');
  r(80, 108, 133, 27, '#927c68');
  r(80, 140, 133, 30, '#a18a6e');
  const colors = ['#789693', '#9f8cac', '#d3b476', '#b07d70', '#c6cdaf'];
  for (let i = 0; i < 15; i++) {
    r(85 + i * 8, 114 - (i % 3) * 2, 6, 20 + (i % 3) * 2, colors[i % 5]);
    r(85 + i * 8, 146, 6, 22, colors[(i + 2) % 5]);
  }
  r(74, 134, 145, 5, '#e2c6a4');
  r(74, 170, 145, 8, '#e2c6a4');
  txt('자료 공간', 147, 210, 12, '#817f6b', 'center');
  // Central workspace rug and desks.
  r(266, 209, 409, 196, '#c7c8b5');
  r(272, 215, 397, 184, '#d3d4c1');
  for (let x = 276; x < 663; x += 9) r(x, 218, 2, 179, '#cccebb');
  chair(342, 298);
  chair(580, 298);
  desk(342, 226);
  desk(580, 226);
  r(445, 225, 27, 51, '#ad977f');
  r(449, 228, 19, 12, '#d9c5a8');
  r(449, 244, 19, 12, '#d9c5a8');
  r(449, 260, 19, 12, '#d9c5a8');
  r(456, 233, 5, 2, '#8c7a67');
  plant(459, 205, 0.65);
  // Noticeboard.
  r(77, 29, 128, 59, '#927d67');
  r(81, 33, 120, 51, '#c4ac8b');
  r(90, 42, 25, 27, '#eff0d9');
  r(125, 38, 26, 31, '#dae0c5');
  r(161, 45, 27, 29, '#e8d4c1');
  r(100, 40, 4, 4, '#b77262');
  r(135, 36, 4, 4, '#768e74');
  // Left lounge: rugs, sofa, small coffee table.
  r(78, 370, 188, 130, '#bfcbb8');
  r(83, 375, 178, 120, '#cbd6c1');
  r(80, 383, 61, 99, '#7e967e');
  r(86, 383, 50, 15, '#a4b19b');
  r(86, 401, 40, 33, '#aab9a2');
  r(86, 438, 40, 33, '#aab9a2');
  r(130, 395, 12, 82, '#90a389');
  r(148, 409, 62, 61, '#ac9377');
  r(145, 403, 62, 61, '#e1c9a5');
  r(151, 464, 6, 10, '#977f69');
  r(193, 464, 6, 10, '#977f69');
  r(164, 419, 20, 25, '#e6e8d8');
  r(168, 422, 11, 2, '#a9b5a2');
  r(189, 442, 10, 10, '#f4eee0');
  plant(238, 399, 0.8);
  txt('잠깐 쉬어가요', 173, 528, 12, '#828472', 'center');
  // Review space partition and table.
  r(690, 345, 169, 159, '#c4c0cd');
  r(695, 350, 159, 149, '#d5d1dc');
  chair(715, 389, '#a49aaf');
  chair(812, 389, '#a49aaf');
  chair(715, 467, '#a49aaf');
  chair(812, 467, '#a49aaf');
  r(697, 405, 137, 62, '#ad977e');
  r(693, 399, 137, 62, '#e7d7ba');
  r(738, 411, 39, 26, '#b4c3bf');
  r(744, 416, 27, 17, '#e7f0e6');
  r(713, 434, 18, 14, '#faf8ec');
  r(786, 416, 10, 12, '#f9efdc');
  txt('함께 검토하는 곳', 772, 532, 12, '#858080', 'center');
  // Divider and testing console.
  r(284, 424, 338, 5, '#bbaf97');
  r(288, 429, 5, 26, '#ab9c82');
  r(610, 429, 5, 26, '#ab9c82');
  for (const x of [329, 400, 471, 542]) {
    r(x, 462, 44, 33, '#a59079');
    r(x - 2, 456, 48, 32, '#d3bb9b');
    r(x + 6, 460, 31, 20, '#627a78');
    r(x + 11, 465, 9, 3, '#b4d3b5');
    r(x + 11, 473, 20, 2, '#a8bdb1');
    r(x + 8, 488, 3, 7, '#9b8b77');
  }
  txt('빌드 & 테스트', 457, 526, 12, '#87816d', 'center');
  // Plants and architectural details.
  plant(91, 273, 1.3);
  plant(849, 240, 1.3);
  plant(845, 129, 0.9);
  r(722, 145, 111, 49, '#98aaa2');
  r(726, 149, 103, 41, '#f2f0df');
  txt('좋은 일은 함께.', 778, 174, 14, '#718574', 'center');
  r(45, 547, 842, 10, '#b19c7e');
  r(45, 557, 842, 13, '#c0ab8b');
  r(418, 547, 111, 23, '#ecefe9');
  r(422, 559, 103, 10, '#e1e6dd');
  for (const id of ['claude', 'codex'] as const) {
    const a = agents[id];
    const x = a.x,
      y = a.y;
    const bob = !reduced && a.activity !== 'idle' ? Math.round(Math.sin(time / 220) * 1.5) : 0;
    if (selected === id) {
      r(x - 25, y + 28, 50, 5, '#a4b797');
      r(x - 30, y + 24, 5, 4, '#a4b797');
      r(x + 25, y + 24, 5, 4, '#a4b797');
    }
    ctx.drawImage(workerImage(id), Math.round(x - 32), Math.round(y - 38 + bob), 64, 80);
    r(x - 51, y + 45, 102, 24, '#fbfaf2');
    r(x - 51, y + 69, 102, 2, '#c7c7b6');
    txt(id === 'claude' ? 'Claude' : 'Codex', x - 40, y + 61, 12, '#425146');
    txt(external ? '외부' : seniorityLabels[team[id].seniority], x + 19, y + 61, 10, '#858b77');
    if (a.waiting) {
      r(x - 17, y - 76, 34, 26, '#fff4d6');
      r(x - 3, y - 50, 6, 5, '#fff4d6');
      txt('!', x, y - 57, 20, '#b47f2d', 'center');
    } else if (a.activity !== 'idle') {
      const label = activityLabels[a.activity];
      r(x - 42, y - 72, 84, 23, '#ffffff');
      r(x - 3, y - 49, 6, 5, '#ffffff');
      txt(label, x, y - 56, 11, '#5d7565', 'center');
    }
  }
}
