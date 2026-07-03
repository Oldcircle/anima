/**
 * Need Definitions — 数据驱动的需求系统
 *
 * 所有需求维度通过配置定义，不再硬编码。
 * 加一个新维度只需要在 NEED_DEFINITIONS 中新增一条。
 */

import { financeFeeling } from "./economy.js";

export interface FeelingLevel {
  /** 低于此值触发 */
  below: number;
  severity: "mild" | "moderate" | "urgent";
  /** 自然语言感受描述 */
  text: string;
}

/** 高值特殊感受（如 social > 85 → 想安静） */
export interface HighFeelingLevel {
  above: number;
  text: string;
}

export interface NeedDefinition {
  id: string;
  category: "physical" | "mental" | "social";
  /** 每 tick 衰减量（负数表示下降） */
  decayRate: number;
  /** 初始默认值 */
  defaultValue: number;
  /** 感受化描述，按阈值分级（从低到高排列） */
  feelings: FeelingLevel[];
  /** 高值时的特殊感受 */
  highFeelings?: HighFeelingLevel[];
}

// ─── 6 维需求定义 ───

export const NEED_DEFINITIONS: NeedDefinition[] = [
  {
    id: "hunger",
    category: "physical",
    // -1/tick × 96 ticks/day = -96/天，配合 3 顿饭（每顿 ~30-40 恢复）
    // 起点 80 + 3 餐 90 = 170 - 96 衰减 = 74，能撑过一整天
    decayRate: -1,
    defaultValue: 80,
    feelings: [
      { below: 15, severity: "urgent", text: "饿到胃在抽痛，必须马上吃点东西。" },
      { below: 30, severity: "moderate", text: "饿得有点发晕，得找地方吃饭了。" },
      { below: 60, severity: "mild", text: "肚子有点饿了。" },
    ],
  },
  {
    id: "energy",
    category: "physical",
    decayRate: -1,
    defaultValue: 100,
    feelings: [
      { below: 15, severity: "urgent", text: "累到站不稳，眼睛都快睁不开了。" },
      { below: 30, severity: "moderate", text: "眼皮很重，脑子转得慢，很想躺下来。" },
      { below: 60, severity: "mild", text: "有点累了，打了个哈欠。" },
    ],
  },
  {
    id: "social",
    category: "social",
    decayRate: -1,
    defaultValue: 60,
    feelings: [
      { below: 15, severity: "urgent", text: "一个人待太久了，心里空荡荡的，很想找人说说话。" },
      { below: 30, severity: "moderate", text: "有点寂寞，想找人聊聊。" },
      { below: 50, severity: "mild", text: "有点想找人说说话。" },
    ],
    highFeelings: [
      { above: 90, text: "今天已经聊了很多了，脑子有点转不动，很想一个人安静待着。" },
      { above: 75, text: "今天和人聊了不少，想安静待一会儿。" },
    ],
  },
  {
    id: "hygiene",
    category: "physical",
    decayRate: -0.5,
    defaultValue: 90,
    feelings: [
      { below: 20, severity: "urgent", text: "浑身不舒服，必须洗澡。" },
      { below: 30, severity: "moderate", text: "身上黏糊糊的，该洗个澡了。" },
      { below: 50, severity: "mild", text: "身上不太清爽。" },
    ],
  },
  {
    id: "fun",
    category: "mental",
    decayRate: -1.5,
    defaultValue: 70,
    feelings: [
      { below: 15, severity: "urgent", text: "闷得发慌，再不找点乐子要疯了。" },
      { below: 30, severity: "moderate", text: "好无聊，什么都提不起劲。" },
      { below: 60, severity: "mild", text: "有点无聊，想找点事做。" },
    ],
    highFeelings: [
      { above: 90, text: "心情很好，不用特地找乐子，做什么都觉得还行。" },
    ],
  },
  {
    id: "bladder",
    category: "physical",
    decayRate: -1,
    defaultValue: 90,
    feelings: [
      { below: 15, severity: "urgent", text: "快憋不住了，必须马上找厕所。" },
      { below: 30, severity: "moderate", text: "憋得有点难受，得找个地方解决。" },
      { below: 60, severity: "mild", text: "有点想上厕所。" },
    ],
  },
];

// ─── 工具函数 ───

/** 获取所有需求 ID */
export function getAllNeedIds(): string[] {
  return NEED_DEFINITIONS.map((d) => d.id);
}

/** 通过 ID 获取需求定义 */
export function getNeedDefinition(id: string): NeedDefinition | undefined {
  return NEED_DEFINITIONS.find((d) => d.id === id);
}

/** 生成默认需求值 */
export function getDefaultNeeds(): Record<string, number> {
  const needs: Record<string, number> = {};
  for (const def of NEED_DEFINITIONS) {
    needs[def.id] = def.defaultValue;
  }
  return needs;
}

/** 获取衰减率映射 */
export function getDecayRates(): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const def of NEED_DEFINITIONS) {
    if (def.decayRate !== 0) {
      rates[def.id] = def.decayRate;
    }
  }
  return rates;
}

/**
 * 将需求值转化为自然语言身体感受。
 * 满的不提，偏低用身体感受，极低用紧急措辞。
 */
export function formatBodyFeelings(needs: Record<string, number>, gold: number, hour?: number, income?: number): string {
  const feelings: string[] = [];

  for (const def of NEED_DEFINITIONS) {
    const value = needs[def.id];
    if (value === undefined) continue;

    // 检查高值感受
    if (def.highFeelings) {
      for (const hf of def.highFeelings) {
        if (value > hf.above) {
          feelings.push(hf.text);
          break;
        }
      }
    }

    // 检查低值感受（feelings 从 urgent→mild 排列，即 below 从小到大）
    // 匹配第一个 value < below 的条目
    for (const fl of def.feelings) {
      if (value < fl.below) {
        feelings.push(fl.text);
        break;
      }
    }
  }

  // 财务体感（相对日常开销折算"撑得了几天"，比裸金额更贴生活；宽裕时不啰嗦）
  const financeLine = financeFeeling(gold, income);
  if (financeLine) feelings.push(financeLine);

  // 多维极端组合
  if (gold === 0 && (needs.hunger ?? 100) < 20) {
    feelings.push("又穷又饿，处境很危险。");
  }
  // 累 + 饿 → 身体在发警报
  const isExhausted = (needs.energy ?? 100) < 20;
  const isStarving = (needs.hunger ?? 100) < 20;
  if (isExhausted && isStarving) {
    feelings.push("又饿又困，身体快撑不住了，得先解决最紧急的。");
  }
  // 多项中度同时出现 → 暗示"别光聊天了"
  const moderateCount = NEED_DEFINITIONS.filter(d => {
    const v = needs[d.id];
    return v !== undefined && v < 40 && d.id !== "social";
  }).length;
  if (moderateCount >= 3) {
    feelings.push("好几件事都在拉警报，得先处理最难受的。");
  }

  // 生活节律：饭点。吃饭是节律不是应激——肚子不满时到点就会惦记，而不是饿到低血糖才想起来
  if (hour !== undefined) {
    const hunger = needs.hunger ?? 100;
    if (hunger < 65) {
      if (hour >= 6 && hour < 9) {
        feelings.push("早上还没正经吃东西，想找点早饭垫垫。");
      } else if (hour >= 11 && hour < 13) {
        feelings.push("到饭点了，肚子开始惦记午饭。");
      } else if (hour >= 17 && hour < 20) {
        feelings.push("天色暗下来了，差不多该吃晚饭了。");
      }
    }
  }

  // 深夜生物钟
  if (hour !== undefined) {
    if (hour >= 0 && hour < 5) {
      feelings.push("已经是深夜了，正常人都已经睡了。你也该回家休息了。");
    } else if (hour >= 22) {
      feelings.push("夜深了，有点困了，差不多该回家了。");
    }
  }

  if (feelings.length === 0) return "身体状态不错，精神也好。";
  return feelings.join("");
}
