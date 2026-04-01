/**
 * Social Modifier — 同场社交自动效果调整
 *
 * 同一工具在独处 vs 有认识的人在场时产生不同效果。
 * 不是新工具，是同一行为的社交变体。
 *
 * 设计原则：
 * - 只对"有认识的人在场"生效（relationship.level > 0）
 * - 效果是增量修正（叠加在原有效果之上）
 * - observableState 也会变化（"一个人吃" vs "和爱音一起吃"）
 */

import type { ActionEffect, ActionResult } from "../actions/types.js";
import type { RelationshipManager } from "../world/relationships.js";

export interface SocialModifierRule {
  /** 需求效果增量修正 */
  needAdjustments: Record<string, number>;
  /** 给在场认识的人的额外效果 */
  nearbyEffects?: Record<string, number>;
  /** 可观察状态后缀（会替换原始 observableState） */
  observableHint: (companionName: string) => string;
}

/**
 * 社交修正规则表。
 *
 * 每个 action 在有认识的人同场时，效果自动调整。
 * 设计来源：DESIGN.md §3.1 "同一活动的 solo 与 social 是不同体验"
 */
const SOCIAL_MODIFIER_RULES: Record<string, SocialModifierRule> = {
  // 一起吃饭：hunger 恢复略少（光顾说话），但 social+ fun+
  eat: {
    needAdjustments: { hunger: -5, social: 8, fun: 5 },
    nearbyEffects: { social: 3 },
    observableHint: (name) => `和${name}一起吃着东西，边吃边随意聊着。`,
  },
  // 一起散步：fun 略少，但 social+（散步适合深聊）
  walk: {
    needAdjustments: { fun: -3, social: 8 },
    nearbyEffects: { social: 5 },
    observableHint: (name) => `和${name}并肩走着，不急不慢。`,
  },
  walk_beach: {
    needAdjustments: { fun: -2, social: 8 },
    nearbyEffects: { social: 5 },
    observableHint: (name) => `和${name}沿着海边走着，海风吹得两人头发乱飘。`,
  },
  // 一起喝东西：fun++ social++ 但更容易喝多
  drink: {
    needAdjustments: { fun: 5, social: 10, bladder: -5 },
    nearbyEffects: { social: 5, fun: 3 },
    observableHint: (name) => `和${name}各端着一杯，有一搭没一搭地聊着。`,
  },
  drink_coffee: {
    needAdjustments: { social: 8, fun: 3 },
    nearbyEffects: { social: 3 },
    observableHint: (name) => `和${name}面对面坐着喝咖啡，偶尔搭几句话。`,
  },
  // 同事在场工作：social+ 但效率可能降低
  knead_dough: {
    needAdjustments: { social: 5, energy: 2 },
    observableHint: (name) => `和${name}一起在后厨忙着，偶尔交换一下眼神。`,
  },
  make_coffee: {
    needAdjustments: { social: 5, energy: 2 },
    observableHint: (name) => `在吧台做咖啡，${name}也在旁边忙着。`,
  },
  serve_customer: {
    needAdjustments: { social: 4 },
    observableHint: (name) => `和${name}一前一后招呼着客人。`,
  },
  clean_table: {
    needAdjustments: { social: 3 },
    observableHint: (name) => `和${name}一起收拾桌面，配合得挺默契。`,
  },
  arrange_flowers: {
    needAdjustments: { social: 4, fun: 2 },
    observableHint: (name) => `和${name}一起整理花束，偶尔递一下花枝。`,
  },
  shelve_books: {
    needAdjustments: { social: 3 },
    observableHint: (name) => `和${name}各抱一摞书在书架间穿梭。`,
  },
  // 一起看书：各看各的，但有个伴在旁边
  read: {
    needAdjustments: { social: 3 },
    observableHint: (name) => `和${name}各看各的书，偶尔抬头对视一下。`,
  },
  // 坐着发呆 / 休息：有人陪着比独处稍好
  rest: {
    needAdjustments: { social: 4, fun: 2 },
    observableHint: (name) => `和${name}安静地坐着，谁也没急着说话。`,
  },
  sit: {
    needAdjustments: { social: 3, fun: 2 },
    observableHint: (name) => `和${name}坐在一起，像是各想各的事。`,
  },
  // 看星星
  stargaze: {
    needAdjustments: { social: 6, fun: 3 },
    observableHint: (name) => `和${name}并排坐着看星星，偶尔指指天上。`,
  },
  // 捡贝壳
  collect_shells: {
    needAdjustments: { social: 4, fun: 3 },
    observableHint: (name) => `和${name}一起蹲着挑拣贝壳，有时举起来给对方看。`,
  },
};

export interface ApplySocialModifierParams {
  actionName: string;
  result: ActionResult;
  actorId: string;
  nearbyCharacterIds: string[];
  relationships: RelationshipManager;
  /** 获取角色显示名 */
  getCharacterName: (id: string) => string;
}

export interface SocialModifierResult {
  /** 需要额外应用的效果 */
  extraEffects: ActionEffect[];
  /** 替换后的 observableState（如果有） */
  observableState?: string;
  /** 社交修正是否生效 */
  applied: boolean;
  /** 生效时的同伴名字 */
  companionName?: string;
}

/**
 * 检查并计算社交修正效果。
 *
 * 只在行为成功时调用。会找到在场最亲近的认识人，应用对应规则。
 */
export function applySocialModifier(params: ApplySocialModifierParams): SocialModifierResult {
  const { actionName, result, actorId, nearbyCharacterIds, relationships, getCharacterName } = params;

  // 行为失败不应用
  if (result.success === false) {
    return { extraEffects: [], applied: false };
  }

  const rule = SOCIAL_MODIFIER_RULES[actionName];
  if (!rule) {
    return { extraEffects: [], applied: false };
  }

  // 找在场最亲近的认识人（relationship.level > 0）
  let bestCompanion: { id: string; level: number } | undefined;
  for (const otherId of nearbyCharacterIds) {
    const rel = relationships.get(actorId, otherId);
    if (rel.level > 0) {
      if (!bestCompanion || rel.level > bestCompanion.level) {
        bestCompanion = { id: otherId, level: rel.level };
      }
    }
  }

  if (!bestCompanion) {
    return { extraEffects: [], applied: false };
  }

  const companionName = getCharacterName(bestCompanion.id);
  const extraEffects: ActionEffect[] = [];

  // 对行为者的需求增量修正
  for (const [field, delta] of Object.entries(rule.needAdjustments)) {
    extraEffects.push({
      type: "need_change",
      targetId: actorId,
      field,
      delta,
    });
  }

  // 对在场同伴的额外效果
  if (rule.nearbyEffects) {
    for (const [field, delta] of Object.entries(rule.nearbyEffects)) {
      extraEffects.push({
        type: "need_change",
        targetId: bestCompanion.id,
        field,
        delta,
      });
    }
  }

  return {
    extraEffects,
    observableState: rule.observableHint(companionName),
    applied: true,
    companionName,
  };
}

/** 获取所有有社交修正规则的 action 名称 */
export function getSocialModifierActions(): string[] {
  return Object.keys(SOCIAL_MODIFIER_RULES);
}
