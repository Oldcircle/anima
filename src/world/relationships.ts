/**
 * Relationship Manager — 角色关系管理
 *
 * 关系模型（借鉴模拟人生）：
 * - friendship: 友谊轴（-100~100），对称，双方共享
 * - bond: 显式关系身份（通过动作改变，如 colleague/partner）
 * - type: 从 friendship 自动推算的标签（stranger → best_friend）
 */

export interface Relationship {
  characterA: string;
  characterB: string;
  level: number;        // -100 到 100（friendship 轴）
  type: RelationType;
  /** 显式关系身份（通过特定动作设定，如同事/恋人/前任） */
  bond?: BondType;
  history: string[];    // 关键事件摘要
  lastInteraction: number; // 上次互动的 tick
  /**
   * 未解开的疙瘩（积怨状态机）：吵完架不是下一 tick 就忘。
   * 存在期间：见面时注入"你们上次不欢而散"、talk 的 flat 好感被冻结；
   * 道歉/安慰/送礼解开（+和好回弹），3 游戏天无事自然淡化。
   */
  grudge?: { reason: string; instigatorId: string; sinceTick: number };
  /** 本对上一次因 talk 加分的 tick（同一 tick 内主轮+反应轮级联只计一次，防棘轮） */
  lastTalkTick?: number;
}

export type RelationType =
  | "stranger"
  | "acquaintance"
  | "friend"
  | "close_friend"
  | "best_friend"
  | "rival"
  | "romantic";

export type BondType =
  | "colleague"   // 同事
  | "roommate"    // 室友
  | "partner"     // 恋人
  | "ex"          // 前任
  | "mentor"      // 师徒
  | "rival";      // 宿敌

function typeFromLevel(level: number): RelationType {
  if (level < -20) return "rival";
  if (level < 10) return "stranger";
  if (level < 30) return "acquaintance";
  if (level < 60) return "friend";
  if (level < 85) return "close_friend";
  return "best_friend";
}

/**
 * talk 对关系的边际收益：随当前水位递减，让关系「深了要维护、不是聊得越多越无脑涨」。
 * 陌生→点头之交给满分推力，越亲近增得越慢，best_friend 几乎只靠维持。
 * 这是打破 valence 正向通胀的核心之一（配合 per-tick 去重 + idle 衰减）。
 */
export function talkGain(level: number): number {
  if (level < 30) return 1.0;   // stranger / acquaintance：破冰阶段涨得快
  if (level < 60) return 0.5;   // friend：变慢
  if (level < 85) return 0.25;  // close_friend：更慢
  return 0.1;                   // best_friend：基本只维持
}

function relationshipKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export class RelationshipManager {
  private _relationships = new Map<string, Relationship>();

  /** 获取两人的关系 */
  get(a: string, b: string): Relationship {
    const key = relationshipKey(a, b);
    let rel = this._relationships.get(key);
    if (!rel) {
      rel = {
        characterA: a < b ? a : b,
        characterB: a < b ? b : a,
        level: 0,
        type: "stranger",
        history: [],
        lastInteraction: 0,
      };
      this._relationships.set(key, rel);
    }
    return rel;
  }

  /** 初始化关系（从角色卡加载） */
  set(a: string, b: string, level: number, type?: RelationType): void {
    const key = relationshipKey(a, b);
    this._relationships.set(key, {
      characterA: a < b ? a : b,
      characterB: a < b ? b : a,
      level: Math.max(-100, Math.min(100, level)),
      type: type ?? typeFromLevel(level),
      history: [],
      lastInteraction: 0,
    });
  }

  /** 修改关系值 */
  modify(a: string, b: string, delta: number, tick: number, eventSummary?: string): void {
    const rel = this.get(a, b);
    rel.level = Math.max(-100, Math.min(100, rel.level + delta));
    rel.type = typeFromLevel(rel.level);
    rel.lastInteraction = tick;
    if (eventSummary) {
      rel.history.push(eventSummary);
      // 只保留最近 20 条
      if (rel.history.length > 20) {
        rel.history = rel.history.slice(-20);
      }
    }
  }

  /**
   * talk 推动关系：按当前水位递减（talkGain）+ 每对每 tick 只计一次。
   * 后者是关键——对话大头在反应轮，一个 tick 内 A↔B 你来我往好几句，
   * 若每句 +1 就是棘轮；这里级联只算一次，把「一次对话」折成「一次关系微调」。
   * 疙瘩期冻结加分（尬聊不等于和好），但仍更新 lastInteraction 免得同时被 idle 衰减。
   * 返回实际增量（0 = 被冻结/本 tick 已计），供上层记账/日志。
   */
  registerTalk(a: string, b: string, tick: number): number {
    const rel = this.get(a, b);
    if (rel.grudge) {
      rel.lastInteraction = tick;
      return 0;
    }
    if (rel.lastTalkTick === tick) {
      rel.lastInteraction = tick;
      return 0;
    }
    rel.lastTalkTick = tick;
    const gain = talkGain(rel.level);
    rel.level = Math.max(-100, Math.min(100, rel.level + gain));
    rel.type = typeFromLevel(rel.level);
    rel.lastInteraction = tick;
    return gain;
  }

  /**
   * 空窗关系每（游戏）天向 0 轻微回落——关系要维护，不是只涨不跌的累加器。
   * 只动「超过 idleTicks 没互动」的对，向 0 收（正的降、负的升），幅度不超过其绝对值。
   * 疙瘩另有淡化逻辑，跳过。不更新 lastInteraction（否则永远 decay 不动）。
   */
  applyIdleDecay(tick: number, idleTicks: number, amount: number): number {
    let touched = 0;
    for (const rel of this._relationships.values()) {
      if (rel.grudge) continue;
      if (tick - rel.lastInteraction < idleTicks) continue;
      if (Math.abs(rel.level) < 0.5) continue;
      const step = Math.min(amount, Math.abs(rel.level));
      rel.level += rel.level > 0 ? -step : step;
      rel.type = typeFromLevel(rel.level);
      touched++;
    }
    return touched;
  }

  /** 结下疙瘩（吵架/被偷等冲突后调用） */
  setGrudge(a: string, b: string, reason: string, instigatorId: string, tick: number): void {
    const rel = this.get(a, b);
    rel.grudge = { reason, instigatorId, sinceTick: tick };
  }

  /** 解开疙瘩（道歉/安慰/送礼/时间淡化） */
  clearGrudge(a: string, b: string): void {
    const rel = this.get(a, b);
    rel.grudge = undefined;
  }

  /** 获取某个角色的所有关系 */
  getRelationshipsOf(characterId: string): Array<{ otherId: string; relationship: Relationship }> {
    const result: Array<{ otherId: string; relationship: Relationship }> = [];
    for (const rel of this._relationships.values()) {
      if (rel.characterA === characterId) {
        result.push({ otherId: rel.characterB, relationship: rel });
      } else if (rel.characterB === characterId) {
        result.push({ otherId: rel.characterA, relationship: rel });
      }
    }
    return result;
  }

  /** 设置显式关系身份 */
  setBond(a: string, b: string, bond: BondType | undefined, tick: number, eventSummary?: string): void {
    const rel = this.get(a, b);
    rel.bond = bond;
    rel.lastInteraction = tick;
    if (eventSummary) {
      rel.history.push(eventSummary);
      if (rel.history.length > 20) {
        rel.history = rel.history.slice(-20);
      }
    }
  }

  /** 获取所有关系 */
  getAll(): Relationship[] {
    return Array.from(this._relationships.values());
  }
}
