import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src-tauri', 'icons');

// Variant 9: Morandi Dusty Blue + Blush — centered layout
function makeSvg(size) {
  // Scale factor relative to 256 base
  const s = size / 256;

  // All coordinates centered in 256x256 viewBox
  // Pill: centered at x=128, width=56, so x=100..156
  // EQ bars: symmetric around center
  // Left bars at: 30, 48, 66   (distances from pill: 70, 52, 34 from center-left edge=100)
  // Right bars at: 172, 190, 208 (mirror)
  // Center of left group: 48, center of right group: 190
  // Distance from center: pill center=128, left group center=48 → 80px, right group center=190 → 62px
  // FIX: make symmetric. Pill center = 128. Bars should be equidistant.
  // Left bars: 34, 50, 66 (center of group = 50, distance from pill left edge 100 = 34)
  // Right bars: 172, 188, 204 (center of group = 188, distance from pill right edge 156 = 32)
  // Better: center everything. Pill at 100-156 (center 128).
  // Bars: inner pair at 68 and 172 (60px from center), mid pair at 48 and 192 (80px from center), outer pair at 30 and 210 (98px from center)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#262830"/>
      <stop offset="100%" stop-color="#2e2a32"/>
    </linearGradient>
    <linearGradient id="pill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#93aec1"/>
      <stop offset="50%" stop-color="#b89eaa"/>
      <stop offset="100%" stop-color="#c4928a"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg)"/>

  <!-- Pill mic - centered at 128 -->
  <rect x="100" y="48" width="56" height="152" rx="28" fill="url(#pill)"/>

  <!-- Grille lines -->
  ${size >= 48 ? `
  <line x1="112" y1="76" x2="144" y2="76" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <line x1="112" y1="92" x2="144" y2="92" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <line x1="112" y1="108" x2="144" y2="108" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <line x1="112" y1="124" x2="144" y2="124" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <line x1="112" y1="140" x2="144" y2="140" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <line x1="112" y1="156" x2="144" y2="156" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  ` : ''}

  <!-- EQ bars - symmetric around center (128) -->
  <!-- Outer pair: 30 and 218 (98px from center) -->
  <rect x="30" y="120" width="8" height="36" rx="4" fill="#93aec1" opacity="0.30"/>
  <rect x="218" y="120" width="8" height="36" rx="4" fill="#c4928a" opacity="0.30"/>

  <!-- Mid pair: 48 and 200 (80px from center) -->
  <rect x="48" y="92" width="8" height="80" rx="4" fill="#93aec1" opacity="0.50"/>
  <rect x="200" y="92" width="8" height="80" rx="4" fill="#c4928a" opacity="0.50"/>

  <!-- Inner pair: 68 and 180 (60px from center) -->
  <rect x="68" y="104" width="8" height="60" rx="4" fill="#b89eaa" opacity="0.40"/>
  <rect x="180" y="104" width="8" height="60" rx="4" fill="#b89eaa" opacity="0.40"/>
</svg>`;
}

const sizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = [];

for (const size of sizes) {
  const svg = makeSvg(size);
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  pngBuffers.push(buf);

  // Also save 256px as standalone PNG for reference
  if (size === 256) {
    writeFileSync(join(outDir, 'icon-256.png'), buf);
  }
}

const icoBuffer = await pngToIco(pngBuffers);
writeFileSync(join(outDir, 'icon.ico'), icoBuffer);

console.log(`Generated icon.ico with sizes: ${sizes.join(', ')}px`);
console.log(`Output: ${join(outDir, 'icon.ico')}`);
