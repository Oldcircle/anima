/** Character game object — pixel sprite + name label + dialog bubble. */

import Phaser from "phaser";
import { CHAR_FRAMES } from "../config";

const MOVE_SPEED = 80; // px/s in tile coords (before scale)
const BUBBLE_DURATION = 5000;

export class Character {
  id: string;
  charName: string;
  sprite: Phaser.GameObjects.Image;
  nameLabel: Phaser.GameObjects.Text;
  private bubbleBg: Phaser.GameObjects.Graphics;
  private bubbleText: Phaser.GameObjects.Text;
  private bubbleVisible = false;
  private bubbleTimer?: Phaser.Time.TimerEvent;
  private scene: Phaser.Scene;
  private selected = false;

  constructor(scene: Phaser.Scene, id: string, name: string, x: number, y: number) {
    this.scene = scene;
    this.id = id;
    this.charName = name;

    const frame = CHAR_FRAMES[id] ?? 85;

    // Character sprite from dungeon tileset
    this.sprite = scene.add.image(x, y, "chars", frame);
    this.sprite.setDepth(10);
    this.sprite.setInteractive({ pixelPerfect: false, useHandCursor: true });

    // Name label
    this.nameLabel = scene.add.text(x, y - 12, name, {
      fontSize: "5px",
      fontFamily: "monospace",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 1.5,
      resolution: 3,
    }).setOrigin(0.5).setDepth(12);

    // Dialog bubble (hidden initially)
    this.bubbleBg = scene.add.graphics().setDepth(13);
    this.bubbleText = scene.add.text(x, y - 22, "", {
      fontSize: "4px",
      fontFamily: "monospace",
      color: "#1a1a2e",
      wordWrap: { width: 60 },
      lineSpacing: 1,
      resolution: 3,
    }).setOrigin(0.5, 1).setDepth(14);
    this.hideBubble();
  }

  setPosition(x: number, y: number): void {
    this.sprite.setPosition(x, y);
    this.nameLabel.setPosition(x, y - 12);
    this.updateBubblePos();
  }

  moveTo(tx: number, ty: number, onComplete?: () => void): void {
    const dist = Phaser.Math.Distance.Between(this.sprite.x, this.sprite.y, tx, ty);
    const duration = Math.max((dist / MOVE_SPEED) * 1000, 150);

    this.scene.tweens.add({
      targets: this.sprite,
      x: tx,
      y: ty,
      duration,
      ease: "Sine.easeInOut",
      onUpdate: () => {
        this.nameLabel.setPosition(this.sprite.x, this.sprite.y - 12);
        this.updateBubblePos();
      },
      onComplete: () => onComplete?.(),
    });
  }

  showBubble(text: string): void {
    if (!text) return;
    const display = text.length > 40 ? text.slice(0, 38) + "…" : text;
    this.bubbleText.setText(display);

    const tw = Math.max(this.bubbleText.width + 6, 20);
    const th = this.bubbleText.height + 4;

    this.bubbleBg.clear();
    // Background rounded rect
    this.bubbleBg.fillStyle(0xffffff, 0.95);
    this.bubbleBg.fillRoundedRect(-tw / 2, -th, tw, th, 2);
    // Triangle pointer
    this.bubbleBg.fillTriangle(-2, 0, 2, 0, 0, 3);

    this.bubbleVisible = true;
    this.bubbleBg.setVisible(true);
    this.bubbleText.setVisible(true);
    this.bubbleBg.setAlpha(1);
    this.bubbleText.setAlpha(1);
    this.updateBubblePos();

    if (this.bubbleTimer) this.bubbleTimer.destroy();
    this.bubbleTimer = this.scene.time.delayedCall(BUBBLE_DURATION, () => {
      this.scene.tweens.add({
        targets: [this.bubbleBg, this.bubbleText],
        alpha: 0,
        duration: 800,
        onComplete: () => this.hideBubble(),
      });
    });
  }

  hideBubble(): void {
    this.bubbleVisible = false;
    this.bubbleBg.setVisible(false);
    this.bubbleText.setVisible(false);
  }

  setSelected(val: boolean): void {
    this.selected = val;
    if (val) {
      this.sprite.setTint(0xffff88);
      this.sprite.setDepth(15);
      this.nameLabel.setDepth(16);
    } else {
      this.sprite.clearTint();
      this.sprite.setDepth(10);
      this.nameLabel.setDepth(12);
    }
  }

  getPos(): { x: number; y: number } {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  destroy(): void {
    this.sprite.destroy();
    this.nameLabel.destroy();
    this.bubbleBg.destroy();
    this.bubbleText.destroy();
    if (this.bubbleTimer) this.bubbleTimer.destroy();
  }

  private updateBubblePos(): void {
    if (!this.bubbleVisible) return;
    const bx = this.sprite.x;
    const by = this.sprite.y - 18;
    this.bubbleBg.setPosition(bx, by);
    this.bubbleText.setPosition(bx, by - this.bubbleText.height / 2 - 2);
  }
}
