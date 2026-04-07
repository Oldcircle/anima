/** UIScene — HTML overlay HUD: time bar, character sidebar, detail panel, event log. */

import Phaser from "phaser";
import { CHAR_FRAMES } from "../config";
import type { WorldState } from "../systems/WorldState";
import type { TownScene } from "./TownScene";
import type { CharacterSnapshot, TickData } from "../types";

export class UIScene extends Phaser.Scene {
  private town!: TownScene;
  private root!: HTMLDivElement;
  private timeEl!: HTMLSpanElement;
  private weatherEl!: HTMLSpanElement;
  private dayEl!: HTMLSpanElement;
  private connEl!: HTMLSpanElement;
  private sidebar!: HTMLDivElement;
  private detail!: HTMLDivElement;
  private log!: HTMLDivElement;
  private selectedId: string | null = null;

  constructor() {
    super({ key: "UIScene" });
  }

  init(data: { townScene: TownScene }) {
    this.town = data.townScene;
  }

  create(): void {
    this.buildUI();

    this.town.events.on("world-update", (w: WorldState) => {
      this.refreshTopBar(w);
      this.refreshSidebar(w);
      if (this.selectedId) this.refreshDetail(w, this.selectedId);
    });

    this.town.events.on("tick-events", (w: WorldState, t: TickData) => {
      this.appendLog(w, t);
    });

    this.town.events.on("char-selected", (id: string | null) => {
      this.selectedId = id;
      if (id) {
        this.detail.style.display = "block";
        this.refreshDetail(this.town.world, id);
      } else {
        this.detail.style.display = "none";
      }
      this.refreshSidebar(this.town.world);
    });

    // Connection status
    this.town.wsClient.on("connected", () => {
      this.connEl.textContent = "● 已连接";
      this.connEl.style.color = "#4ade80";
    });
    this.town.wsClient.on("disconnected", () => {
      this.connEl.textContent = "○ 断开";
      this.connEl.style.color = "#f87171";
    });
  }

  private buildUI(): void {
    // Inject CSS
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.id = "hud";
    document.body.appendChild(this.root);

    // Top bar
    const top = el("div", "hud-top");
    this.timeEl = el("span", "hud-time", "06:00") as HTMLSpanElement;
    this.weatherEl = el("span", "hud-weather", "☀️") as HTMLSpanElement;
    this.dayEl = el("span", "hud-day", "Day 1") as HTMLSpanElement;
    const speeds = el("div", "hud-speeds");
    for (const s of [0, 1, 2, 4]) {
      const btn = el("button", s === 1 ? "hud-spd active" : "hud-spd", s === 0 ? "⏸" : `${s}×`);
      btn.addEventListener("click", () => {
        this.town.wsClient.setSpeed(s);
        speeds.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
      speeds.appendChild(btn);
    }
    this.connEl = el("span", "hud-conn", "连接中…") as HTMLSpanElement;
    top.append(this.timeEl, this.weatherEl, this.dayEl, speeds, this.connEl);
    this.root.appendChild(top);

    // Sidebar
    this.sidebar = el("div", "hud-side") as HTMLDivElement;
    this.root.appendChild(this.sidebar);

    // Detail panel
    this.detail = el("div", "hud-detail") as HTMLDivElement;
    this.detail.style.display = "none";
    this.root.appendChild(this.detail);

    // Event log
    this.log = el("div", "hud-log") as HTMLDivElement;
    this.log.innerHTML = '<div class="log-title">📜 事件</div>';
    this.root.appendChild(this.log);
  }

  private refreshTopBar(w: WorldState): void {
    this.timeEl.textContent = w.formattedTime;
    const icons: Record<string, string> = { sunny: "☀️", cloudy: "☁️", rainy: "🌧", stormy: "⛈" };
    this.weatherEl.textContent = icons[w.weather] ?? w.weather;
    this.dayEl.textContent = `Day ${w.gameTime.day}`;
  }

  private refreshSidebar(w: WorldState): void {
    this.sidebar.innerHTML = "";
    for (const ch of w.characters.values()) {
      const btn = el("div", `hud-char${this.selectedId === ch.id ? " sel" : ""}`);
      const name = w.getName(ch.id);
      const status = ch.observableState?.summary ?? ch.currentAction?.name ?? "";
      btn.innerHTML = `<b>${name}</b><span class="hud-char-status">${status}</span>`;
      btn.addEventListener("click", () => this.town.selectCharacter(ch.id));
      this.sidebar.appendChild(btn);
    }
  }

  private refreshDetail(w: WorldState, id: string): void {
    const ch = w.characters.get(id);
    if (!ch) return;
    const name = w.getName(id);
    const loc = w.getLoc(ch.locationId);
    const status = ch.observableState?.summary ?? ch.currentAction?.name ?? "闲着";

    this.detail.innerHTML = `
      <div class="det-head"><b>${name}</b><button class="det-close">✕</button></div>
      <div class="det-status">${status}</div>
      <div class="det-info">📍 ${loc?.name ?? ch.locationId} · 💰 ${ch.gold}</div>
      ${ch.life ? `<div class="det-info">${ch.life.occupation}${ch.life.aspiration ? ` · 💭 ${ch.life.aspiration}` : ""}</div>` : ""}
      ${ch.moodlets?.length ? `<div class="det-moods">${ch.moodlets.map((m) => `<span class="mood">${m.emotion}</span>`).join("")}</div>` : ""}
      <div class="det-needs">${this.needBars(ch)}</div>
    `;
    this.detail.querySelector(".det-close")?.addEventListener("click", () => this.town.selectCharacter(null));
  }

  private needBars(ch: CharacterSnapshot): string {
    if (!ch.needs) return "";
    const labels: Record<string, string> = { hunger: "饱", energy: "力", social: "社", hygiene: "洁", fun: "乐", bladder: "生" };
    return Object.entries(ch.needs).map(([k, v]) => {
      const pct = Phaser.Math.Clamp(v, 0, 100);
      const color = pct > 60 ? "#4ade80" : pct > 30 ? "#facc15" : "#f87171";
      return `<div class="need"><span>${labels[k] ?? k}</span><div class="bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div></div>`;
    }).join("");
  }

  private appendLog(w: WorldState, t: TickData): void {
    for (const ev of t.events) {
      if (ev.skipped) continue;
      const name = w.getName(ev.characterId);
      const text = ev.observableState ?? ev.description ?? ev.action;
      const line = el("div", `log-entry${ev.action === "talk" ? " talk" : ""}`);
      line.innerHTML = `<span class="log-t">${t.formattedTime}</span> <b>${name}</b> ${text}`;
      this.log.appendChild(line);
    }
    // Keep last 40
    const entries = this.log.querySelectorAll(".log-entry");
    for (let i = 0; i < entries.length - 40; i++) entries[i].remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const CSS = `
#hud{position:fixed;inset:0;pointer-events:none;z-index:10;font-family:'PingFang SC','Hiragino Sans GB',system-ui,sans-serif;font-size:13px;color:#c9d1d9}
#hud>*{pointer-events:auto}

.hud-top{position:absolute;top:0;left:0;right:0;height:36px;background:rgba(13,17,23,.92);border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:center;padding:0 16px;gap:14px}
.hud-time{font-size:17px;font-weight:700;color:#58a6ff;font-variant-numeric:tabular-nums}
.hud-weather{font-size:14px}
.hud-day{color:#8b949e;font-size:12px}
.hud-speeds{display:flex;gap:3px;margin-left:auto}
.hud-spd{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#8b949e;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px}
.hud-spd:hover{border-color:#58a6ff;color:#fff}
.hud-spd.active{background:#1f6feb;color:#fff;border-color:#1f6feb}
.hud-conn{font-size:11px;color:#484f58;margin-left:8px}

.hud-side{position:absolute;top:44px;left:8px;display:flex;flex-direction:column;gap:5px}
.hud-char{background:rgba(13,17,23,.88);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:6px 10px;cursor:pointer;min-width:100px;transition:border-color .15s}
.hud-char:hover{border-color:rgba(255,255,255,.3)}
.hud-char.sel{border-color:#ffd700;background:rgba(255,215,0,.08)}
.hud-char b{display:block;font-size:12px;color:#e6edf3}
.hud-char-status{display:block;font-size:10px;color:#8b949e;margin-top:2px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.hud-detail{position:absolute;top:44px;right:8px;width:260px;max-height:calc(100vh - 130px);overflow-y:auto;background:rgba(13,17,23,.92);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:12px;color:#c9d1d9}
.det-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.det-head b{font-size:15px;color:#f0f6fc}
.det-close{background:none;border:none;color:#484f58;cursor:pointer;font-size:14px}
.det-close:hover{color:#f0f6fc}
.det-status{font-size:12px;color:#8b949e;margin-bottom:8px;line-height:1.5}
.det-info{font-size:11px;color:#8b949e;margin-bottom:4px}
.det-moods{margin:6px 0}
.mood{display:inline-block;font-size:11px;background:rgba(255,255,255,.06);border-radius:4px;padding:2px 6px;margin:0 3px 3px 0}
.det-needs{margin-top:8px}
.need{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.need span{font-size:10px;color:#8b949e;width:16px;text-align:right}
.bar{flex:1;height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
.fill{height:100%;border-radius:3px;transition:width .3s}

.hud-log{position:absolute;bottom:0;left:0;right:0;height:80px;background:rgba(13,17,23,.88);border-top:1px solid rgba(255,255,255,.1);overflow-y:auto;padding:6px 16px;font-size:11px;color:#8b949e}
.log-title{font-weight:600;color:#484f58;margin-bottom:3px}
.log-entry{margin-bottom:2px;line-height:1.5}
.log-entry.talk{color:#c9d1d9}
.log-entry b{color:#58a6ff}
.log-t{color:#484f58}

.hud-detail::-webkit-scrollbar,.hud-log::-webkit-scrollbar{width:4px}
.hud-detail::-webkit-scrollbar-thumb,.hud-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:2px}
`;
