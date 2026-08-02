/**
 * World Events — 导演硬事件原语的世界侧结算（DESIGN-revival B2）
 *
 * 三条硬事件（inject_world_event v1 菜单）：
 * - theft_with_perp：失窃（延迟发现制）。真凶只允许两种：npc 登记表里的静态 NPC，
 *   或锚定某 cast 成员**真实执行过的 steal**（近窗 recentActions）——**世界绝不从 cast
 *   挑真凶塞赃物**（红线：那等于替 agent 写行为+伪造证据链）。真金转移+赃物入真凶背包
 *   （持久物证）+受害者"去取货款"intent→到场才落发现记忆；风声晚于发现。
 * - accident_damage：意外损毁（物品毁掉或赔一笔钱），只造处境不写结果。
 * - letter_arrival：镇外来信。必带实体信物品+cause；剧本门控（manifest world_events
 *   声明才解锁，同步给真实边界块加豁免行——见 prompt-builder / break-config）。
 *
 * 本模块是**纯世界写入函数**：被两条通路共用——
 * ① 导演工具 handler（director-tools.ts）：同步校验+配额后 enqueueMutation 包一层入队；
 * ② beat auto_events 机械注入（simulation._autoEventHandlers）：drain 时直接调。
 * off 档（治愈系基线）两条通路都被本模块内的档位闸拒绝（defense in depth）。
 */

import type { World } from "../world/world.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import { getBreakLevel, isWorldEventEnabled } from "../agent/break-config.js";
import { addMoodlet } from "../world/moodlets.js";
import { addToInventory, hasItem, removeFromInventory, resolveItem } from "../world/item-registry.js";

// ── 配额/冷却常量（形状进单测，数值可调）──

/** 周池窗口：7 游戏天 */
export const WORLD_EVENT_WEEK_TICKS = 672;
/** 周池容量：每周最多 2 次 inject_world_event（全类型合计） */
export const WORLD_EVENT_WEEK_POOL = 2;
/** 每类冷却：同类硬事件至少隔 2 游戏天 */
export const WORLD_EVENT_TYPE_COOLDOWN_TICKS = 192;
/** surface_grudge 每对冷却：1 游戏天 */
export const SURFACE_GRUDGE_COOLDOWN_TICKS = 96;
/** surface_grudge 催化门槛：pair 压力 ≥ 此值才算"已有旧账"（催化不无中生有） */
export const SURFACE_GRUDGE_MIN_PRESSURE = 25;
/** 风声延迟：发现记忆落地后至少这么多 tick 才起风声 */
export const DISCOVERY_RUMOR_DELAY_TICKS = 8;
/** cast 真凶锚定窗：steal 必须发生在近 2 游戏天内 */
export const STEAL_ANCHOR_WINDOW_TICKS = 192;
/** 赃物物证的物品 id（item-registry KEEPSAKES） */
export const STOLEN_EVIDENCE_ITEM = "stolen_pouch";

export const WORLD_EVENT_TYPES = ["theft_with_perp", "accident_damage", "letter_arrival"] as const;
export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

export interface WorldEventDeps {
  world: World;
  memory: ShortTermMemory;
  tick: number;
}

export interface WorldEventOutcome {
  ok: boolean;
  description: string;
  error?: string;
}

// ── 配额（计数挂 narrative_state.world 随档——导演内存态重启即失控）──

/**
 * 检查并**预定**一次硬事件配额：同类冷却 → 周池，都过则立即记账。
 * 同步调用（导演 handler 内），保证同一 invoke 连发两次时第二次真被拒。
 */
export function checkAndReserveWorldEventQuota(
  world: World,
  type: WorldEventType,
  tick: number,
): { ok: true } | { ok: false; error: string; description: string } {
  const quota = world.narrative.getWorldEventQuota();
  const last = quota.lastByType[type];
  if (last !== undefined && tick - last < WORLD_EVENT_TYPE_COOLDOWN_TICKS) {
    return {
      ok: false,
      error: "type_cooldown",
      description: `硬事件 ${type} 冷却中（上次 tick ${last}，需隔 ${WORLD_EVENT_TYPE_COOLDOWN_TICKS} tick）`,
    };
  }
  const week = String(Math.floor(tick / WORLD_EVENT_WEEK_TICKS));
  const used = quota.usedByWeek[week] ?? 0;
  if (used >= WORLD_EVENT_WEEK_POOL) {
    return {
      ok: false,
      error: "quota_exhausted",
      description: `本周硬事件配额已用完（${used}/${WORLD_EVENT_WEEK_POOL}）——好钢用在刀刃上，改用软工具`,
    };
  }
  // 预定：立即记账 + 顺手清掉过期周的计数（Record 不无限膨胀）
  for (const k of Object.keys(quota.usedByWeek)) {
    if (k !== week) delete quota.usedByWeek[k];
  }
  quota.usedByWeek[week] = used + 1;
  quota.lastByType[type] = tick;
  return { ok: true };
}

// ── 真凶资格（红线）──

/**
 * theft_with_perp 的真凶资格：npc 登记表里的 NPC，或近窗真实执行过 steal 的 cast 成员。
 * 都不是 → null（世界绝不从 cast 挑真凶）。
 */
export function perpEligibility(world: World, perpId: string, tick: number): "npc" | "anchored_steal" | null {
  if (world.narrative.isNpc(perpId)) return "npc";
  const state = world.getCharacter(perpId);
  if (!state) return null;
  const anchored = (state.recentActions ?? []).some(
    (a) => a.actionId === "steal" && tick - a.tick <= STEAL_ANCHOR_WINDOW_TICKS,
  );
  return anchored ? "anchored_steal" : null;
}

// ── 硬事件结算 ──

export interface TheftParams {
  perpId: string;
  victimId: string;
  amount: number;
  /** 发现地点；缺省 = 受害者 workplace */
  discoveryLocationId?: string;
  /** 因果伪装（受害者为什么会去取钱/钱为什么在那）——必填 */
  cause: string;
}

/**
 * 失窃（延迟发现制）：真金转移 + 赃物入真凶背包（持久物证）+ 受害者"去取货款"intent；
 * 发现记忆/未解决事件/风声全部挂 pendingDiscoveries，受害者到场才落账。
 */
export function applyTheftWithPerp(deps: WorldEventDeps, params: TheftParams): WorldEventOutcome {
  if (getBreakLevel() === "off") {
    return { ok: false, description: "off 档硬事件禁用（治愈系基线）", error: "break_level_off" };
  }
  if (!params.cause || params.cause.trim().length === 0) {
    return { ok: false, description: "theft_with_perp 必须带 cause（因果伪装）", error: "missing_cause" };
  }
  const { world, tick } = deps;
  const victim = world.getCharacter(params.victimId);
  const perp = world.getCharacter(params.perpId);
  if (!victim || !perp) {
    return { ok: false, description: `未知角色（perp=${params.perpId}, victim=${params.victimId}）`, error: "unknown_character" };
  }
  const eligibility = perpEligibility(world, params.perpId, tick);
  if (!eligibility) {
    return {
      ok: false,
      description: `拒绝：${params.perpId} 不是合法真凶——只允许 npc 登记的 NPC，或近窗真实执行过 steal 的角色（世界不替 cast 写行为）`,
      error: "perp_not_eligible",
    };
  }
  const amount = Math.floor(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, description: `amount 必须是正数（got ${params.amount}）`, error: "invalid_amount" };
  }
  const discoveryLocId = params.discoveryLocationId ?? victim.life?.workplace;
  const discoveryLoc = discoveryLocId ? world.getLocation(discoveryLocId) : undefined;
  if (!discoveryLoc) {
    return { ok: false, description: `发现地点不存在（${discoveryLocId ?? "未指定且受害者无工作地点"}）`, error: "invalid_location" };
  }

  // 1) 真金转移（金币守恒：受害者丢多少，真凶得多少）
  const taken = Math.min(amount, victim.gold);
  victim.gold -= taken;
  perp.gold += taken;

  // 2) 赃物入真凶背包（持久物证——调查线索的物理载体）
  addToInventory(perp.inventory, STOLEN_EVIDENCE_ITEM, 1, { obtainedTick: tick });

  // 3) 受害者"去取货款"intent（只配注意力：去不去、什么时候去归角色）
  world.setIntent(params.victimId, {
    kind: "plan",
    source: "action",
    summary: `${params.cause}——该去${discoveryLoc.name}把收着的钱取出来点点了。`,
    createdTick: tick,
    expiresAt: tick + 32,
  });

  // 4) 延迟发现（随档）：到场才落发现记忆；风声必须晚于发现
  world.narrative.addPendingDiscovery({
    id: `theft_${tick}_${params.victimId}`,
    victimId: params.victimId,
    locationId: discoveryLoc.id,
    discoveryMemory: `你到了${discoveryLoc.name}，翻开自己收钱的铁盒——里面的${taken}金币不翼而飞！锁扣上有被撬动过的痕迹。${params.cause}，这笔钱本来就指着用的`,
    observable: "脸色发白地翻着一只空铁盒，手都在抖。",
    intentSummary: `收着的${taken}金币被人偷了。得弄清楚是谁干的——这事不能就这么算了。`,
    rumor: `听说${victim.name}收着的一笔钱不翼而飞了，铁盒被撬得干干净净`,
    unresolvedEvent: {
      id: `theft_${tick}_${params.victimId}`,
      summary: `${victim.name}收在${discoveryLoc.name}的${taken}金币失窃了，不知道是谁干的`,
      involved: [params.victimId],
      visibleTo: [params.victimId],
    },
    createdTick: tick,
  });

  return {
    ok: true,
    description: `失窃已注入（真凶=${params.perpId}[${eligibility}]，${taken} 金币已真实转移，赃物入包）。受害者 ${victim.name} 将在到达${discoveryLoc.name}时发现`,
  };
}

export interface AccidentParams {
  targetId: string;
  /** 被毁物品（defId 或中文名，须真实持有） */
  item?: string;
  /** 或：赔/修一笔钱（以身上的钱为限，不会扣成负数） */
  goldCost?: number;
  cause: string;
}

/** 意外损毁：毁一件真实持有的物品，或损失一笔钱。带 moodlet + recover intent。 */
export function applyAccidentDamage(deps: WorldEventDeps, params: AccidentParams): WorldEventOutcome {
  if (getBreakLevel() === "off") {
    return { ok: false, description: "off 档硬事件禁用（治愈系基线）", error: "break_level_off" };
  }
  if (!params.cause || params.cause.trim().length === 0) {
    return { ok: false, description: "accident_damage 必须带 cause（事故的来龙去脉）", error: "missing_cause" };
  }
  const { world, memory, tick } = deps;
  const target = world.getCharacter(params.targetId);
  if (!target) {
    return { ok: false, description: `未知角色 ${params.targetId}`, error: "unknown_character" };
  }

  if (params.item) {
    const def = resolveItem(params.item);
    if (!def) {
      return { ok: false, description: `世界里没有「${params.item}」这种物品`, error: "unknown_item" };
    }
    if (!hasItem(target.inventory ?? [], def.id)) {
      return { ok: false, description: `${target.name} 身上没有${def.name}——不能毁掉不存在的东西`, error: "item_not_held" };
    }
    removeFromInventory(target.inventory, def.id, 1);
    memory.add(params.targetId, {
      tick, type: "event",
      content: `${params.cause}——你的${def.name}彻底毁了，怎么都救不回来`,
      importance: 7,
    });
    addMoodlet(target, "sad", 3, `${def.name}毁了`, 24, "event", tick);
    world.setIntent(params.targetId, {
      kind: "recover", source: "action",
      summary: `${def.name}毁了（${params.cause}），得想想怎么办。`,
      createdTick: tick, expiresAt: tick + 12,
    });
    return { ok: true, description: `意外已注入：${target.name} 的${def.name}被毁（${params.cause}）` };
  }

  const cost = Math.floor(params.goldCost ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) {
    return { ok: false, description: "accident_damage 需要 item 或正数 gold_cost 之一", error: "missing_payload" };
  }
  const lost = Math.min(cost, target.gold);
  target.gold -= lost;
  memory.add(params.targetId, {
    tick, type: "event",
    content: `${params.cause}——赔进去${lost}金币，心疼得直抽抽`,
    importance: 7,
  });
  addMoodlet(target, "anxious", 3, "一场意外赔了钱", 24, "event", tick);
  world.setIntent(params.targetId, {
    kind: "recover", source: "action",
    summary: `${params.cause}，一下少了${lost}金币。这窟窿得想办法补上。`,
    createdTick: tick, expiresAt: tick + 12,
  });
  return { ok: true, description: `意外已注入：${target.name} 损失 ${lost} 金币（${params.cause}）` };
}

export interface LetterParams {
  recipientId: string;
  /** 寄信人（镇外之人，只有信来，人不来） */
  fromWhom: string;
  /** 信的内容概要（进收信人记忆） */
  contentSummary: string;
  cause: string;
}

/**
 * 镇外来信：实体信物品入包 + 记忆 + intent。剧本门控——manifest 未声明
 * world_events: [letter_arrival] 时拒绝（否则信与真实边界"镇外之人联系不上"打架）。
 */
export function applyLetterArrival(deps: WorldEventDeps, params: LetterParams): WorldEventOutcome {
  if (getBreakLevel() === "off") {
    return { ok: false, description: "off 档硬事件禁用（治愈系基线）", error: "break_level_off" };
  }
  if (!isWorldEventEnabled("letter_arrival")) {
    return {
      ok: false,
      description: "letter_arrival 未被当前剧本启用（manifest world_events 未声明）——真实边界块没有豁免行，信会与物理法则打架",
      error: "letter_not_enabled",
    };
  }
  if (!params.cause || params.cause.trim().length === 0) {
    return { ok: false, description: "letter_arrival 必须带 cause（信为什么此刻寄到）", error: "missing_cause" };
  }
  if (!params.fromWhom || !params.contentSummary) {
    return { ok: false, description: "letter_arrival 需要 from_whom 与 content_summary", error: "missing_payload" };
  }
  const { world, memory, tick } = deps;
  const recipient = world.getCharacter(params.recipientId);
  if (!recipient) {
    return { ok: false, description: `未知角色 ${params.recipientId}`, error: "unknown_character" };
  }

  // 实体信物品（真实边界：谈得起的东西必须真的在手里）
  addToInventory(recipient.inventory, "letter", 1, { giftedBy: params.fromWhom, obtainedTick: tick });
  memory.add(params.recipientId, {
    tick, type: "event",
    content: `${params.cause}。一封${params.fromWhom}寄来的信送到了你手里：${params.contentSummary}`,
    importance: 8,
  });
  world.setIntent(params.recipientId, {
    kind: "recover", source: "action",
    summary: `${params.fromWhom}的信还揣在身上。信里说的事在心里翻腾，想找个安静的地方再读一遍，或者找人说说。`,
    createdTick: tick, expiresAt: tick + 16,
  });
  return { ok: true, description: `来信已注入：${params.fromWhom} → ${recipient.name}（信已入随身物品）` };
}

// ── 延迟发现 sweep（simulation 每 tick 调，决策前——发现记忆进本 tick prompt）──

/**
 * 处理延迟发现队列：受害者到场 → 落发现记忆/未解决事件/现场氛围/intent；
 * 发现后隔 DISCOVERY_RUMOR_DELAY_TICKS 才释放风声（风声必须晚于 ≥1 个发现记忆）。
 */
export function processPendingDiscoveries(world: World, memory: ShortTermMemory, tick: number): void {
  if (getBreakLevel() === "off") return;
  const pending = world.narrative.getPendingDiscoveries();
  if (pending.length === 0) return;

  const done = new Set<string>();
  for (const d of pending) {
    if (d.discoveredTick === undefined) {
      const victim = world.getCharacter(d.victimId);
      if (!victim) {
        done.add(d.id);
        continue;
      }
      if (victim.locationId !== d.locationId) continue;
      // 到场 → 发现落账
      memory.add(d.victimId, { tick, type: "event", content: d.discoveryMemory, importance: 8 });
      if (d.unresolvedEvent) {
        world.narrative.addUnresolvedEvent({ ...d.unresolvedEvent, createdTick: tick });
      }
      if (d.observable) {
        world.setObservableState(d.victimId, {
          actionName: "__discovery__", source: "action",
          summary: d.observable,
          createdTick: tick, expiresAt: tick + 6,
        });
      }
      if (d.intentSummary) {
        world.setIntent(d.victimId, {
          kind: "recover", source: "action",
          summary: d.intentSummary,
          createdTick: tick, expiresAt: tick + 12,
        });
      }
      d.discoveredTick = tick;
      console.log(`🕳️ [发现] ${victim.name} 在 ${d.locationId} 发现了 [${d.id}]`);
      if (!d.rumor) done.add(d.id);
    } else if (d.rumor && tick >= d.discoveredTick + DISCOVERY_RUMOR_DELAY_TICKS) {
      // 风声晚于发现记忆
      world.narrative.getWorld().rumors.push({
        content: d.rumor, sourceCharId: undefined, tick, reachedChars: [],
      });
      done.add(d.id);
      console.log(`🌬️ [风声] ${d.rumor.slice(0, 40)}…`);
    }
  }
  if (done.size > 0) {
    const kept = pending.filter((d) => !done.has(d.id));
    pending.length = 0;
    pending.push(...kept);
  }
}
