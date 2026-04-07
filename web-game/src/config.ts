import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { TownScene } from "./scenes/TownScene";
import { UIScene } from "./scenes/UIScene";

export const TILE = 16;
export const SCALE = 3;
export const MAP_COLS = 50;
export const MAP_ROWS = 40;
export const MAP_PX_W = MAP_COLS * TILE;
export const MAP_PX_H = MAP_ROWS * TILE;

export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: 1280,
  height: 720,
  pixelArt: true,
  roundPixels: true,
  backgroundColor: "#2a5c3f",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, TownScene, UIScene],
};

/** Character sprite frame index in tiny-dungeon tilemap_packed (12 cols) */
export const CHAR_FRAMES: Record<string, number> = {
  tomori: 85,   // brown-haired girl — introverted
  anon: 88,     // brown-haired lively — social butterfly
  sakiko: 86,   // red-brown hair — elegant
  mutsumi: 98,  // brown quiet — silent
  soyo: 84,     // purple mage — gentle/mysterious
};

/** Location pixel positions on the map + spawn offsets */
export interface LocDef {
  id: string;
  name: string;
  /** Center tile col */
  col: number;
  /** Center tile row */
  row: number;
  /** Spawn offsets from center (in pixels) for multiple characters */
  spawns: { dx: number; dy: number }[];
}

export const LOCATIONS: LocDef[] = [
  // Forest (top-left)
  { id: "forest",      name: "森林",     col: 8,  row: 3,  spawns: [{dx:-12,dy:0},{dx:12,dy:0},{dx:0,dy:10},{dx:-8,dy:-8}] },
  // Farm (top-right)
  { id: "farm",        name: "农场",     col: 40, row: 3,  spawns: [{dx:-10,dy:0},{dx:10,dy:0},{dx:0,dy:8},{dx:-6,dy:-6}] },
  // Residential
  { id: "home_tomori", name: "灯的家",   col: 8,  row: 10, spawns: [{dx:0,dy:8}] },
  { id: "home_anon",   name: "爱音的家", col: 16, row: 10, spawns: [{dx:0,dy:8}] },
  { id: "home_sakiko", name: "祥子的家", col: 24, row: 10, spawns: [{dx:0,dy:8}] },
  { id: "home_mutsumi",name: "睦的家",   col: 32, row: 10, spawns: [{dx:0,dy:8}] },
  { id: "home_soyo",   name: "素世的家", col: 40, row: 10, spawns: [{dx:0,dy:8}] },
  // Library
  { id: "library",     name: "图书馆",   col: 6,  row: 18, spawns: [{dx:-8,dy:8},{dx:8,dy:8},{dx:0,dy:12}] },
  // Commercial street
  { id: "flower_shop", name: "花店",     col: 15, row: 17, spawns: [{dx:0,dy:10},{dx:-8,dy:8},{dx:8,dy:8}] },
  { id: "bakery",      name: "面包坊",   col: 23, row: 17, spawns: [{dx:0,dy:10},{dx:-8,dy:8},{dx:8,dy:8}] },
  { id: "cafe",        name: "咖啡馆",   col: 31, row: 17, spawns: [{dx:0,dy:10},{dx:-8,dy:8},{dx:8,dy:8}] },
  { id: "plaza",       name: "广场",     col: 25, row: 22, spawns: [{dx:-10,dy:-6},{dx:10,dy:-6},{dx:-6,dy:6},{dx:6,dy:6},{dx:0,dy:0}] },
  { id: "shop",        name: "杂货店",   col: 39, row: 17, spawns: [{dx:0,dy:10},{dx:-8,dy:8},{dx:8,dy:8}] },
  { id: "bar",         name: "酒吧",     col: 39, row: 22, spawns: [{dx:0,dy:10},{dx:-8,dy:8},{dx:8,dy:8}] },
  // Coast
  { id: "beach",       name: "海滩",     col: 15, row: 30, spawns: [{dx:-12,dy:0},{dx:12,dy:0},{dx:0,dy:-6},{dx:-6,dy:6}] },
  { id: "dock",        name: "码头",     col: 38, row: 28, spawns: [{dx:-6,dy:0},{dx:6,dy:0},{dx:0,dy:-6}] },
];
