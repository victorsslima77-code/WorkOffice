import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const rawDir = path.join(rootDir, 'assets', 'raw');
const outDir = path.join(rootDir, 'apps', 'web', 'public', 'assets');

async function loadSharp() {
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm');
  const entries = await fs.readdir(pnpmDir);
  const sharpFolder = entries.find((name) => name.startsWith('sharp@'));
  if (!sharpFolder) {
    throw new Error('Pacote sharp nao encontrado em node_modules/.pnpm');
  }
  const sharpEntry = path.join(pnpmDir, sharpFolder, 'node_modules', 'sharp', 'lib', 'index.js');
  const mod = await import(pathToFileURL(sharpEntry).href);
  return mod.default;
}

function buildPhaserAtlasJson({ imageFileName, width, height, cols, rows, animations }) {
  const frameW = Math.floor(width / cols);
  const frameH = Math.floor(height / rows);
  const frames = {};

  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const frameName = `frame_${index}`;
      frames[frameName] = {
        frame: { x: c * frameW, y: r * frameH, w: frameW, h: frameH },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frameW, h: frameH },
        sourceSize: { w: frameW, h: frameH },
        anchor: { x: 0.5, y: 0.88 },
      };
      index++;
    }
  }

  return {
    frames,
    animations,
    meta: {
      app: 'WorkOffice Asset Pipeline',
      version: '1.0.0',
      image: imageFileName,
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
    },
  };
}

function buildWalkableGrid() {
  const cols = 43;
  const rows = 24;
  // 1 = bloqueado (parede/movel/fora do mapa), 0 = caminhavel
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));

  const markRectWalkable = (c1, r1, c2, r2) => {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r >= 0 && r < rows && c >= 0 && c < cols) {
          grid[r][c] = 0;
        }
      }
    }
  };

  // Corredor central
  markRectWalkable(19, 8, 25, 19);

  // Sala de Reuniao (ao redor da mesa e quadro branco + porta)
  markRectWalkable(15, 7, 18, 11);
  markRectWalkable(8, 9, 15, 11);

  // Copa / Descanso (balcao de cafe, entrada e ao redor do pebolim)
  markRectWalkable(16, 15, 19, 17);
  markRectWalkable(9, 15, 16, 17);
  markRectWalkable(13, 17, 16, 20);

  // Baia 1 (superior direita: porta, estante e cadeira CRT)
  markRectWalkable(25, 6, 33, 8);

  // Baia 2 (meio direita: porta, estante e cadeira CRT)
  markRectWalkable(25, 12, 33, 14);

  // Baia 3 (inferior direita: porta, estante e cadeira CRT)
  markRectWalkable(25, 18, 33, 20);

  return {
    cols,
    rows,
    tileWidth: 32,
    tileHeight: 32,
    imageWidth: 1376,
    imageHeight: 768,
    grid,
    hotspots: {
      spawn_door: { col: 21, row: 13, facing: 'down', label: 'Corredor Central' },
      meeting_table: { col: 15, row: 9, facing: 'up_left', label: 'Sala de Reunião' },
      whiteboard: { col: 16, row: 8, facing: 'up_left', label: 'Quadro Branco' },
      coffee_machine: { col: 10, row: 16, facing: 'up_left', label: 'Cafeteira (Copa)' },
      foosball: { col: 14, row: 19, facing: 'down', label: 'Mesa de Pebolim (Copa)' },
      desk_1: {
        chair: { col: 32, row: 7, facing: 'up_right', label: 'Baia 1 — Computador CRT' },
        shelf: { col: 28, row: 6, facing: 'up_left', label: 'Baia 1 — Estante de Pastas' },
      },
      desk_2: {
        chair: { col: 32, row: 13, facing: 'up_right', label: 'Baia 2 — Computador CRT' },
        shelf: { col: 28, row: 12, facing: 'up_left', label: 'Baia 2 — Estante de Pastas' },
      },
      desk_3: {
        chair: { col: 32, row: 19, facing: 'up_right', label: 'Baia 3 — Computador CRT' },
        shelf: { col: 28, row: 18, facing: 'up_left', label: 'Baia 3 — Estante de Pastas' },
      },
    },
  };
}

async function main() {
  const sharp = await loadSharp();
  await fs.mkdir(outDir, { recursive: true });

  // 1. Copiar os arquivos PNG convertidos para apps/web/public/assets/
  const filesToCopy = [
    ['office.png', 'office.png'],
    ['characters.png', 'characters-sheet-1.png'],
    ['characters 2.png', 'characters-sheet-2.png'],
    ['character 1.png', 'character-1-sprites.png'],
    ['character 2.png', 'character-2-sprites.png'],
    ['character 3.png', 'character-3-sprites.png'],
  ];

  for (const [srcName, destName] of filesToCopy) {
    const srcPath = path.join(rawDir, srcName);
    const destPath = path.join(outDir, destName);
    await fs.copyFile(srcPath, destPath);
    console.log(`Copiado: ${srcName} -> public/assets/${destName}`);
  }

  // 2. Recortar retratos individuais em PNG transparente a partir de characters.png e characters 2.png
  const sheet1Path = path.join(rawDir, 'characters.png');
  const meta1 = await sharp(sheet1Path).metadata();
  const w1 = meta1.width ?? 1376;
  const h1 = meta1.height ?? 768;
  const halfW1 = Math.floor(w1 / 2);

  const buf1Left = await sharp(sheet1Path)
    .extract({ left: 0, top: 0, width: halfW1, height: h1 })
    .png()
    .toBuffer();
  await sharp(buf1Left).trim().toFile(path.join(outDir, 'character-1-portrait.png'));

  const buf1Right = await sharp(sheet1Path)
    .extract({ left: halfW1, top: 0, width: w1 - halfW1, height: h1 })
    .png()
    .toBuffer();
  await sharp(buf1Right).trim().toFile(path.join(outDir, 'character-2-portrait.png'));

  const sheet2Path = path.join(rawDir, 'characters 2.png');
  const meta2 = await sharp(sheet2Path).metadata();
  const w2 = meta2.width ?? 1376;
  const h2 = meta2.height ?? 768;
  const halfW2 = Math.floor(w2 / 2);

  const buf2Left = await sharp(sheet2Path)
    .extract({ left: 0, top: 0, width: halfW2, height: h2 })
    .png()
    .toBuffer();
  await sharp(buf2Left).trim().toFile(path.join(outDir, 'character-3-portrait.png'));

  const buf2Right = await sharp(sheet2Path)
    .extract({ left: halfW2, top: 0, width: w2 - halfW2, height: h2 })
    .png()
    .toBuffer();
  await sharp(buf2Right).trim().toFile(path.join(outDir, 'character-4-portrait.png'));

  // 3. Gerar Atlas JSON do Phaser para character 1, character 2 (8x3) e character 3 (8x4)
  const anims8x3 = {
    walk_down: ['frame_0', 'frame_1', 'frame_2', 'frame_3'],
    walk_up: ['frame_4', 'frame_5', 'frame_6', 'frame_7'],
    walk_side: ['frame_8', 'frame_9', 'frame_10', 'frame_11'],
    sit_type: ['frame_12', 'frame_13', 'frame_14', 'frame_15'],
    drink_coffee_stand: ['frame_16', 'frame_17', 'frame_18', 'frame_19'],
    drink_coffee_sit: ['frame_20', 'frame_21', 'frame_22', 'frame_23'],
  };

  const anims8x4 = {
    walk_down: ['frame_0', 'frame_1', 'frame_2', 'frame_3'],
    walk_up: ['frame_4', 'frame_5', 'frame_6', 'frame_7'],
    walk_side: ['frame_8', 'frame_9', 'frame_10', 'frame_11'],
    sit_type: ['frame_16', 'frame_17', 'frame_18', 'frame_19'],
    drink_coffee_stand: ['frame_24', 'frame_25', 'frame_26', 'frame_27'],
    drink_coffee_sit: ['frame_28', 'frame_29', 'frame_30', 'frame_31'],
  };

  const atlas1 = buildPhaserAtlasJson({
    imageFileName: 'character-1-sprites.png',
    width: 1376,
    height: 768,
    cols: 8,
    rows: 3,
    animations: anims8x3,
  });
  await fs.writeFile(
    path.join(outDir, 'character-1-atlas.json'),
    JSON.stringify(atlas1, null, 2),
    'utf8',
  );

  const atlas2 = buildPhaserAtlasJson({
    imageFileName: 'character-2-sprites.png',
    width: 1376,
    height: 768,
    cols: 8,
    rows: 3,
    animations: anims8x3,
  });
  await fs.writeFile(
    path.join(outDir, 'character-2-atlas.json'),
    JSON.stringify(atlas2, null, 2),
    'utf8',
  );

  const atlas3 = buildPhaserAtlasJson({
    imageFileName: 'character-3-sprites.png',
    width: 1376,
    height: 768,
    cols: 8,
    rows: 4,
    animations: anims8x4,
  });
  await fs.writeFile(
    path.join(outDir, 'character-3-atlas.json'),
    JSON.stringify(atlas3, null, 2),
    'utf8',
  );

  // 4. Exportar configuracao do mapa e grid caminhavel para easystar.js
  const officeMap = buildWalkableGrid();
  await fs.writeFile(
    path.join(outDir, 'office-map.json'),
    JSON.stringify(officeMap, null, 2),
    'utf8',
  );

  console.log('Atlas JSON do Phaser e office-map.json gerados com sucesso em public/assets/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
