/** BootScene — loads real Kenney tilesets then starts TownScene. */

import Phaser from "phaser";

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    // Town tileset (16×16, 12 cols × 11 rows, no spacing)
    this.load.spritesheet("town", "assets/kenney/tiny-town/Tilemap/tilemap_packed.png", {
      frameWidth: 16,
      frameHeight: 16,
      spacing: 0,
      margin: 0,
    });

    // Character sprites from dungeon tileset (same format)
    this.load.spritesheet("chars", "assets/kenney/tiny-dungeon/Tilemap/tilemap_packed.png", {
      frameWidth: 16,
      frameHeight: 16,
      spacing: 0,
      margin: 0,
    });

    // Simple loading text
    const text = this.add.text(
      this.cameras.main.centerX,
      this.cameras.main.centerY,
      "加载中...",
      { fontSize: "16px", color: "#ffffff" }
    ).setOrigin(0.5);

    this.load.on("complete", () => text.destroy());
  }

  create(): void {
    this.scene.start("TownScene");
  }
}
