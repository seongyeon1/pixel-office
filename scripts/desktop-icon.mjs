import { Resvg } from '@resvg/resvg-js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Armchair } from 'lucide-react';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the very same Lucide component and brand colors as the web sidebar.
const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
const brand = css.match(/\.brand-mark\s*\{([^}]+)\}/)?.[1];
const background = brand?.match(/background:\s*(#[\da-f]+)/i)?.[1];
const shadow = brand?.match(/box-shadow:\s*inset\s+0\s+-3px\s+(#[\da-f]+)/i)?.[1];
if (!background || !shadow) throw new Error('웹 로고의 배경색과 그림자 색을 찾을 수 없습니다.');

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } })
    .render()
    .asPng();
}

export function desktopIcon(size = 1024) {
  const chair = renderToStaticMarkup(
    createElement(Armchair, { size: 23, x: 8.5, y: 8.5, color: '#fff' }),
  );
  return png(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <defs><clipPath id="brand"><rect x=".5" width="39" height="40" rx="11"/></clipPath></defs>
    <!-- Dock artwork uses 80% of the canvas, leaving the same optical inset as adjacent apps. -->
    <g transform="translate(4 4) scale(.8)">
    <g clip-path="url(#brand)">
      <rect x=".5" width="39" height="40" rx="11" fill="${shadow}"/>
      <rect x=".5" y="-3" width="39" height="40" rx="11" fill="${background}"/>
    </g>
    ${chair}
    </g>
  </svg>`,
    size,
  );
}

export async function writeDesktopAssets(dir) {
  await mkdir(dir, { recursive: true });
  const chair = renderToStaticMarkup(createElement(Armchair, { size: 18, color: '#000' }));
  await writeFile(join(dir, 'trayTemplate.png'), png(chair, 18));
  await writeFile(join(dir, 'trayTemplate@2x.png'), png(chair, 36));
  await writeFile(join(dir, 'app.png'), desktopIcon(512));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await writeDesktopAssets(fileURLToPath(new URL('../dist/desktop/assets', import.meta.url)));
}
