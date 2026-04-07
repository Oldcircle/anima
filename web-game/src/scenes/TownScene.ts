/** TownScene — renders tilemap, characters, handles camera + WS updates. */

import Phaser from "phaser";
import { TILE, SCALE, MAP_COLS, MAP_ROWS, MAP_PX_W, MAP_PX_H, LOCATIONS } from "../config";
import { generateMap, WATER } from "../tiles";
import { Character } from "../objects/Character";
import { WSClient } from "../systems/WSClient";
import { WorldState } from "../systems/WorldState";
import type { CharacterSnapshot, TickData } from "../types";

export class TownScene extends Phaser.Scene {
  world!: WorldState;
  wsClient!: WSClient;
  characters = new Map<string, Character>();
  private selectedId: string | null = null;
  private isDrag = false;
  private dragPrev = { x: 0, y: 0 };

  constructor() {
    super({ key: "TownScene" });
  }

  create(): void {
    this.world = new WorldState();
    this.wsClient = new WSClient();

    // ── Build tilemap ──
    this.buildMap();

    // ── Location labels ──
    for (const loc of LOCATIONS) {
      const px = loc.col * TILE + TILE / 2;
      const py = loc.row * TILE - 6;
      this.add.text(px, py, loc.name, {
        fontSize: "4px",
        fontFamily: "monospace",
        color: "#ffe0a0",
        stroke: "#000000",
        strokeThickness: 1,
        resolution: 3,
      }).setOrigin(0.5).setDepth(8);
    }

    // ── Camera ──
    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_PX_W, MAP_PX_H);
    cam.setZoom(SCALE);
    cam.centerOn(MAP_PX_W / 2, MAP_PX_H / 3);

    // Camera drag
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.isDrag = true;
      this.dragPrev = { x: p.x, y: p.y };
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.isDrag || !p.isDown) return;
      const dx = (p.x - this.dragPrev.x) / cam.zoom;
      const dy = (p.y - this.dragPrev.y) / cam.zoom;
      cam.scrollX -= dx;
      cam.scrollY -= dy;
      this.dragPrev = { x: p.x, y: p.y };
    });
    this.input.on("pointerup", () => { this.isDrag = false; });

    // Zoom
    this.input.on("wheel", (_p: Phaser.Input.Pointer, _gx: number[], _gy: number[], dy: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom + (dy > 0 ? -0.3 : 0.3), 1.5, 6));
    });

    // ── WebSocket ──
    this.wsClient.on("snapshot", (data) => {
      this.world.applySnapshot(data);
      this.initCharacters();
      this.events.emit("world-update", this.world);
    });

    this.wsClient.on("tick", (data) => {
      this.world.applyTick(data);
      this.updateCharacters(data);
      this.events.emit("world-update", this.world);
      this.events.emit("tick-events", this.world, data);
    });

    this.wsClient.connect();

    // Launch UI overlay
    this.scene.launch("UIScene", { townScene: this });
  }

  private buildMap(): void {
    const { ground, buildings, decor } = generateMap();

    // Ground layer — use tilemap from data
    const groundMap = this.make.tilemap({
      data: ground,
      tileWidth: TILE,
      tileHeight: TILE,
    });
    const townTileset = groundMap.addTilesetImage("town", "town", TILE, TILE, 0, 0)!;
    const groundLayer = groundMap.createLayer(0, townTileset, 0, 0)!;
    groundLayer.setDepth(0);

    // Tint water tiles blue
    groundLayer.forEachTile((tile) => {
      if (tile.index === WATER) {
        tile.tint = 0x3b7dd8;
      }
    });

    // Building layer
    const bldgMap = this.make.tilemap({
      data: buildings.map((row) => row.map((t) => (t === -1 ? -1 : t))),
      tileWidth: TILE,
      tileHeight: TILE,
    });
    const bldgTileset = bldgMap.addTilesetImage("town", "town", TILE, TILE, 0, 0)!;
    const bldgLayer = bldgMap.createLayer(0, bldgTileset, 0, 0)!;
    bldgLayer.setDepth(3);

    // Decoration layer
    const decoMap = this.make.tilemap({
      data: decor.map((row) => row.map((t) => (t === -1 ? -1 : t))),
      tileWidth: TILE,
      tileHeight: TILE,
    });
    const decoTileset = decoMap.addTilesetImage("town", "town", TILE, TILE, 0, 0)!;
    const decoLayer = decoMap.createLayer(0, decoTileset, 0, 0)!;
    decoLayer.setDepth(4);
  }

  private initCharacters(): void {
    for (const ch of this.characters.values()) ch.destroy();
    this.characters.clear();

    for (const snap of this.world.characters.values()) {
      this.spawnCharacter(snap);
    }
  }

  private spawnCharacter(snap: CharacterSnapshot): Character {
    const pos = this.world.getSpawnPixel(snap.locationId, snap.id);
    const name = this.world.getName(snap.id);
    const ch = new Character(this, snap.id, name, pos.x, pos.y);

    ch.sprite.on("pointerdown", (p: Phaser.Input.Pointer) => {
      p.event.stopPropagation();
      this.selectCharacter(snap.id);
    });

    this.characters.set(snap.id, ch);
    return ch;
  }

  private updateCharacters(tick: TickData): void {
    for (const snap of tick.characters) {
      let ch = this.characters.get(snap.id);
      if (!ch) ch = this.spawnCharacter(snap);

      // Move if location changed
      if (this.world.didMove(snap.id)) {
        const target = this.world.getSpawnPixel(snap.locationId, snap.id);
        ch.moveTo(target.x, target.y);
      }
    }

    // Dialog bubbles
    for (const evt of tick.events) {
      if (evt.action === "talk" && evt.success !== false && evt.description) {
        const ch = this.characters.get(evt.characterId);
        if (ch) {
          const speech = this.extractSpeech(evt.description);
          ch.showBubble(speech);
        }
      }
    }
  }

  private extractSpeech(desc: string): string {
    const m = desc.match(/[「"'](.*?)[」"']/);
    return m ? m[1] : desc;
  }

  selectCharacter(id: string | null): void {
    if (this.selectedId) this.characters.get(this.selectedId)?.setSelected(false);
    this.selectedId = id;
    if (id) {
      const ch = this.characters.get(id);
      if (ch) {
        ch.setSelected(true);
        const pos = ch.getPos();
        this.cameras.main.pan(pos.x, pos.y, 400, "Sine.easeInOut");
      }
    }
    this.events.emit("char-selected", id);
  }

  getSelectedId(): string | null { return this.selectedId; }
}
