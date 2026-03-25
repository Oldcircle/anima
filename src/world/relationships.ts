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
