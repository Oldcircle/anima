/**
 * Tile index constants for Kenney Tiny Town tilemap_packed.png
 * 12 columns × 11 rows = 132 tiles, 16×16 each, no spacing.
 */

import { MAP_COLS, MAP_ROWS } from "./config";

// ── Terrain ──
export const GRASS = 0;
export const GRASS2 = 1;
export const GRASS_FLOWER = 2;

export const SAND_TL = 12;
export const SAND = 13;
export const SAND_TR = 14;
export const SAND2 = 24;
export const SAND3 = 25;

// ── Trees & Plants ──
export const TREE_AUTUMN = 3;
export const TREE_PINE = 4;
export const BUSH_ROUND = 5;
export const TREE_BIG_TL = 6;
export const TREE_BIG_TR = 7;
export const TREE_BIG_BL = 8;
export const TREE_BIG = 16;
export const BUSH_SMALL = 20;
export const MUSHROOM = 15;
export const RED_MUSHROOM = 29;
export const FLOWER_A = 30;
export const FLOWER_B = 31;
export const FLOWER_C = 32;
export const AUTUMN_A = 9;
export const AUTUMN_B = 10;
export const AUTUMN_C = 11;
export const ACORN = 27;

// ── Paths ──
export const PATH_TL = 36;
export const PATH_T = 37;
export const PATH_TR = 38;
export const PATH_L = 39;
export const PATH_MID = 40;
export const PATH_R = 41;
export const PATH_BL = 48;  // reuse stone TL area
export const PATH_B = 49;
export const PATH_BR = 50;

// ── Fences ──
export const FENCE_POST = 44;
export const FENCE_H = 45;
export const FENCE_POST2 = 46;
export const FENCE_V = 47;

// ── Buildings: Red roof ──
export const ROOF_RED_TL = 60;
export const ROOF_RED_T = 61;
export const ROOF_RED_TR = 62;
export const ROOF_RED_L = 63;
export const ROOF_RED = 64;
export const ROOF_RED_R = 65;

// ── Buildings: Stone wall ──
export const STONE_TL = 48;
export const STONE_T = 49;
export const STONE_TR = 50;
export const STONE_L = 51;
export const STONE_MID = 52;
export const STONE_R = 53;

// ── Buildings: Wood wall ──
export const WOOD_TL = 72;
export const WOOD_T = 73;
export const WOOD_TR = 74;
export const WOOD_L = 75;
export const WOOD_MID = 76;
export const WOOD_R = 77;

// ── Buildings: Brown wall + door ──
export const BROWN_TL = 84;
export const BROWN_T = 85;
export const BROWN_TR = 86;
export const BROWN_DOOR_L = 87;
export const BROWN_DOOR = 88;
export const BROWN_DOOR_R = 89;

// ── Castle ──
export const CASTLE_TL = 96;
export const CASTLE_T = 97;
export const CASTLE_TR = 98;
export const CASTLE_L = 99;
export const CASTLE_MID = 100;
export const CASTLE_R = 101;

// ── Items ──
export const COIN = 78;
export const SIGN = 81;
export const MAILBOX = 82;
export const BREAD = 90;
export const POTION = 91;
export const APPLE = 92;
export const FISH = 94;
export const WELL = 131;
export const LAMP = 117;
export const BARREL = 115;
export const CRATE = 116;
export const BRIDGE = 130;

// ── Water (use dark grass + blue tinting; or reuse snow tiles as water proxy) ──
export const WATER = 42;  // grass variant as base; we'll tint it

// ── Arch / Gate ──
export const ARCH_L = 121;
export const ARCH_MID = 122;
export const ARCH_R = 123;

// ─────────────────────────────────────────
// Map data generation
// ─────────────────────────────────────────

function pick(...items: number[]): number {
  return items[Math.floor(Math.random() * items.length)];
}

/** Fill a rectangular region in a 2D array */
function fillRect(layer: number[][], r1: number, c1: number, r2: number, c2: number, tileFn: () => number) {
  for (let r = r1; r <= r2 && r < MAP_ROWS; r++) {
    for (let c = c1; c <= c2 && c < MAP_COLS; c++) {
      layer[r][c] = tileFn();
    }
  }
}

function setTile(layer: number[][], r: number, c: number, tile: number) {
  if (r >= 0 && r < MAP_ROWS && c >= 0 && c < MAP_COLS) {
    layer[r][c] = tile;
  }
}

/** Place a 3-wide building (roof + wall + door) */
function placeBuilding(bldg: number[][], c: number, r: number, roofTile: number) {
  // Roof row
  setTile(bldg, r, c, ROOF_RED_TL);
  setTile(bldg, r, c + 1, roofTile);
  setTile(bldg, r, c + 2, ROOF_RED_TR);
  // Wall row
  setTile(bldg, r + 1, c, WOOD_L);
  setTile(bldg, r + 1, c + 1, WOOD_MID);
  setTile(bldg, r + 1, c + 2, WOOD_R);
  // Door row
  setTile(bldg, r + 2, c, BROWN_DOOR_L);
  setTile(bldg, r + 2, c + 1, BROWN_DOOR);
  setTile(bldg, r + 2, c + 2, BROWN_DOOR_R);
}

/** Place a 2-wide small house */
function placeHouse(bldg: number[][], c: number, r: number) {
  setTile(bldg, r, c, ROOF_RED_TL);
  setTile(bldg, r, c + 1, ROOF_RED_TR);
  setTile(bldg, r + 1, c, WOOD_L);
  setTile(bldg, r + 1, c + 1, WOOD_R);
  setTile(bldg, r + 2, c, BROWN_DOOR_L);
  setTile(bldg, r + 2, c + 1, BROWN_DOOR);
}

/** Place a large stone building (library/castle style) */
function placeStoneBldg(bldg: number[][], c: number, r: number, w: number) {
  for (let dc = 0; dc < w; dc++) {
    const isL = dc === 0;
    const isR = dc === w - 1;
    setTile(bldg, r, c + dc, isL ? CASTLE_TL : isR ? CASTLE_TR : CASTLE_T);
    setTile(bldg, r + 1, c + dc, isL ? CASTLE_L : isR ? CASTLE_R : CASTLE_MID);
    setTile(bldg, r + 2, c + dc, dc === Math.floor(w / 2) ? BROWN_DOOR : isL ? STONE_L : isR ? STONE_R : STONE_MID);
  }
}

export function generateMap(): { ground: number[][]; buildings: number[][]; decor: number[][] } {
  const ground: number[][] = [];
  const buildings: number[][] = [];
  const decor: number[][] = [];

  // Initialize all layers
  for (let r = 0; r < MAP_ROWS; r++) {
    ground.push(new Array(MAP_COLS).fill(GRASS));
    buildings.push(new Array(MAP_COLS).fill(-1));
    decor.push(new Array(MAP_COLS).fill(-1));
  }

  // ── Ground layer: grass with variants ──
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      ground[r][c] = pick(GRASS, GRASS, GRASS, GRASS2, GRASS2, GRASS_FLOWER);
    }
  }

  // ── Sand beach (rows 28-32) ──
  fillRect(ground, 28, 0, 29, MAP_COLS - 1, () => pick(SAND, SAND2, SAND3));
  fillRect(ground, 30, 0, 31, MAP_COLS - 1, () => pick(SAND, SAND_TL, SAND_TR));

  // ── Water (rows 32-39) ──
  // Use sand3 tile as water proxy with blue tint applied in scene
  fillRect(ground, 32, 0, MAP_ROWS - 1, MAP_COLS - 1, () => WATER);

  // ── Forest area (top-left, rows 0-6, cols 0-18) ──
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 18; c++) {
      if (Math.random() < 0.35) {
        decor[r][c] = pick(TREE_PINE, TREE_BIG, BUSH_ROUND, TREE_PINE, TREE_PINE);
      } else if (Math.random() < 0.1) {
        decor[r][c] = pick(MUSHROOM, FLOWER_A, ACORN);
      }
    }
  }

  // ── Farm area (top-right, rows 0-6, cols 32-49) ──
  for (let r = 1; r < 6; r++) {
    for (let c = 33; c < 48; c++) {
      if (r % 2 === 0) {
        ground[r][c] = pick(SAND2, SAND3); // plowed rows
      }
      if (r % 2 === 1 && c % 3 === 0) {
        decor[r][c] = pick(FLOWER_A, FLOWER_B, FLOWER_C);
      }
    }
  }
  // Farm fence
  for (let c = 32; c < 49; c++) { setTile(decor, 0, c, FENCE_H); }
  for (let r = 0; r < 7; r++) { setTile(decor, r, 32, FENCE_V); setTile(decor, r, 49, FENCE_V); }
  setTile(decor, 0, 32, FENCE_POST); setTile(decor, 0, 49, FENCE_POST);
  setTile(decor, 6, 32, FENCE_POST); setTile(decor, 6, 49, FENCE_POST);

  // ── Paths ──
  // Horizontal residential path (row 12-13)
  fillRect(ground, 12, 3, 12, 46, () => PATH_T);
  fillRect(ground, 13, 3, 13, 46, () => PATH_MID);

  // Vertical main road (col 24-25, rows 13-27)
  for (let r = 13; r <= 27; r++) {
    ground[r][24] = PATH_L;
    ground[r][25] = PATH_R;
  }

  // Commercial street path (row 20-21)
  fillRect(ground, 20, 10, 20, 44, () => PATH_T);
  fillRect(ground, 21, 10, 21, 44, () => PATH_MID);

  // Beach boardwalk (row 27)
  fillRect(ground, 27, 5, 27, 44, () => pick(PATH_MID, PATH_T));

  // ── Residential houses (row 8-10) ──
  placeHouse(buildings, 7, 8);      // tomori
  placeHouse(buildings, 15, 8);     // anon
  placeHouse(buildings, 23, 8);     // sakiko
  placeHouse(buildings, 31, 8);     // mutsumi
  placeHouse(buildings, 39, 8);     // soyo

  // Mailboxes in front of houses
  for (const c of [8, 16, 24, 32, 40]) {
    setTile(decor, 11, c, MAILBOX);
  }

  // ── Commercial buildings (row 15-17) ──
  placeBuilding(buildings, 14, 15, ROOF_RED);  // flower shop
  placeBuilding(buildings, 22, 15, ROOF_RED);  // bakery
  placeBuilding(buildings, 30, 15, ROOF_RED);  // cafe
  placeBuilding(buildings, 38, 15, ROOF_RED);  // shop

  // Bar (row 20-22 area)
  placeBuilding(buildings, 38, 20, ROOF_RED);

  // Signs near shops
  setTile(decor, 18, 14, SIGN);  // flower shop sign
  setTile(decor, 18, 22, SIGN);  // bakery sign
  setTile(decor, 18, 30, SIGN);  // cafe sign
  setTile(decor, 18, 38, SIGN);  // shop sign

  // ── Library (stone building, row 16-18, col 4-8) ──
  placeStoneBldg(buildings, 4, 16, 5);

  // ── Plaza decorations (around col 25, row 22-24) ──
  setTile(decor, 22, 25, WELL);   // well in plaza center
  setTile(decor, 22, 23, LAMP);
  setTile(decor, 22, 27, LAMP);
  setTile(decor, 24, 24, BARREL);
  setTile(decor, 24, 26, CRATE);

  // ── Dock (wooden pier extending into water, col 36-40, row 28-31) ──
  for (let r = 28; r <= 31; r++) {
    setTile(ground, r, 37, BRIDGE);
    setTile(ground, r, 38, BRIDGE);
    setTile(ground, r, 39, BRIDGE);
  }
  setTile(decor, 28, 37, FENCE_POST);
  setTile(decor, 28, 39, FENCE_POST);

  // ── Scatter trees along edges ──
  // Right side trees
  for (let r = 7; r < 28; r += 3) {
    if (Math.random() < 0.6) setTile(decor, r, 48, pick(TREE_PINE, TREE_BIG));
    if (Math.random() < 0.6) setTile(decor, r, 49, pick(TREE_PINE, BUSH_ROUND));
  }
  // Left side trees
  for (let r = 7; r < 28; r += 3) {
    if (Math.random() < 0.5) setTile(decor, r, 0, pick(TREE_PINE, TREE_BIG));
    if (Math.random() < 0.5) setTile(decor, r, 1, pick(BUSH_ROUND, FLOWER_A));
  }

  // Autumn trees near beach
  for (let c = 2; c < 12; c += 3) {
    if (Math.random() < 0.5) setTile(decor, 26, c, pick(AUTUMN_A, AUTUMN_B, AUTUMN_C));
  }

  // Flowers around flower shop
  for (let r = 18; r <= 19; r++) {
    for (let c = 12; c <= 17; c++) {
      if (Math.random() < 0.3 && buildings[r][c] === -1) {
        decor[r][c] = pick(FLOWER_A, FLOWER_B, FLOWER_C);
      }
    }
  }

  return { ground, buildings, decor };
}
