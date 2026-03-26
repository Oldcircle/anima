/**
 * Tool Builder — 情境工具系统
 *
 * 根据角色当前的地点、附近的人、身体状态动态组装可用工具列表。
 * 工具不是全局菜单，而是环境的可供性（affordance）。
 *
 * 设计原则：
 * - 工具描述是一句人话，不是数值说明书
 * - 代价只描述角色会自然预期到的部分（常识）
 * - 社交语境融入描述（"爱音也在——可以一起吃"）
 * - 模型不应看到任何数字效果
 */

import type { ToolDefinition } from "../providers/types.js";
import type { ActionDefinition, ActionResult, ActionContext } from "../actions/types.js";
import type { CharacterState, Location, LocationTool } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";
import { getWorkIncome } from "../world/economy.js";
import { inviteOutAction, shareSecretAction } from "../actions/relationship-actions.js";
import { getItemDef, hasItem, resolveItem } from "../world/item-registry.js";
import type { ShopItem } from "../world/item-types.js";

export interface ToolBuildContext {
  state: CharacterState;
  card: CharacterCard;
  location: Location;
  nearbyCharacters: Array<{ id: string; name: string }>;
  allLocations: Location[];
  gold: number;
  /** 当前游戏时间（小时） */
  hour?: number;
  /** 关系管理器（用于条件浮现关系工具） */
  relationships?: import("../world/relationships.js").RelationshipManager;
}

/**
 * 为角色动态组装当前可用的工具列表。
 */
export function buildToolList(ctx: ToolBuildContext): ActionDefinition[] {
  const tools: ActionDefinition[] = [];

  // 1. 通用工具：go_to（永远可用）
  tools.push(buildGoToTool(ctx));

  // 2. 地点工具（从当前地点 YAML 读取）
  if (ctx.location.tools) {
    for (const lt of ctx.location.tools) {
      const action = buildLocationTool(lt, ctx);
      if (action) tools.push(action);
    }
  }

  // 2b. 员工工具（在自己工作地点时，替代普通地点工具）
  const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
  if (workplace && ctx.location.id === workplace && ctx.location.workerTools) {
    for (const wt of ctx.location.workerTools) {
      const action = buildLocationTool(wt, ctx);
      if (action) tools.push(action);
    }
  }

  // 2c. 商店工具（地点有 shop 时浮现 buy）
  if (ctx.location.shop && ctx.location.shop.length > 0) {
    const buyTool = buildBuyTool(ctx.location.shop, ctx);
    if (buyTool) tools.push(buyTool);
  }

  // 2d. eat：背包有食物/饮品时浮现 + 当前地点商店的食物（直接买了吃）
  {
    const bagFood = (ctx.state.inventory ?? []).filter(i => {
      const def = getItemDef(i.defId);
      return def && def.effects && (def.type === "consumable" || (def.type === "gift" && def.effects));
    });
    const shopFood = (ctx.location.shop ?? []).filter(s => {
      const def = getItemDef(s.id);
      return def && def.effects && def.type === "consumable" && ctx.gold >= s.price;
    });
    if (bagFood.length > 0 || shopFood.length > 0) {
      tools.push(buildEatTool(bagFood, shopFood, ctx));
    }
  }

  // 2e. give：背包非空 + 附近有人
  if ((ctx.state.inventory ?? []).length > 0 && ctx.nearbyCharacters.length > 0) {
    tools.push(buildGiveTool(ctx));
  }

  // 2f. 物品启用的工具（notebook→journal, guitar→practice_music 等）
  for (const item of (ctx.state.inventory ?? [])) {
    const def = getItemDef(item.defId);
    if (def?.enables) {
      for (const toolId of def.enables) {
        if (!tools.some(t => t.tool.name === toolId)) {
          const enabled = buildItemEnabledTool(toolId, def.name, ctx);
          if (enabled) tools.push(enabled);
        }
      }
    }
  }

  // 2g. cook：在家 + 有食材时浮现
  if (ctx.location.type === "residential" && hasItem(ctx.state.inventory ?? [], "ingredients")) {
    tools.push(buildCookTool(ctx));
  }

  // 2h. read：在图书馆时无条件可用（图书馆有书）
  if (ctx.location.id === "library") {
    tools.push({
      tool: { name: "read", description: "从书架上拿本书看。安静但久坐会累。", parameters: { type: "object", properties: { thought: { type: "string", description: "你在想什么" } } } },
      handler: (_args, actx): ActionResult => ({
        description: "在图书馆看书",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 20 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -5 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: -3 },
        ],
        duration: 4,
      }),
    });
  }

  // 3. 社交工具（附近有人时）
  if (ctx.nearbyCharacters.length > 0) {
    tools.push(buildTalkTool(ctx));
    tools.push(buildComfortTool(ctx));

    // argue 只在负面情绪或 fun 极低时浮现
    const dominantMood = ctx.state.moodlets?.length
      ? [...ctx.state.moodlets].sort((a, b) => b.intensity - a.intensity)[0]
      : undefined;
    const hasNegativeMood = dominantMood && ["sad", "angry", "anxious"].includes(dominantMood.emotion);
    if (hasNegativeMood || (ctx.state.needs.fun !== undefined && ctx.state.needs.fun < 30)) {
      tools.push(buildArgueTool(ctx));
    }
  }

  // 3b. 关系深度工具（附近有人 + 关系达标时浮现）
  if (ctx.nearbyCharacters.length > 0 && ctx.relationships) {
    let hasInvite = false;
    let hasSecret = false;
    for (const nearby of ctx.nearbyCharacters) {
      const rel = ctx.relationships.get(ctx.card.id, nearby.id);
      if (!hasInvite && rel.level >= 30) {
        tools.push(inviteOutAction);
        hasInvite = true;
      }
      if (!hasSecret && rel.level >= 60) {
        tools.push(shareSecretAction);
        hasSecret = true;
      }
      if (hasInvite && hasSecret) break;
    }
  }

  // 4. 极端状态工具（平时隐藏）
  if (ctx.gold === 0) {
    tools.push(buildBegTool());
  }
  if (ctx.gold === 0 && (ctx.state.needs.hunger ?? 100) < 20) {
    tools.push(buildStealTool());
  }

  // 去重（防止地点工具和通用工具同名）
  const seen = new Set<string>();
  const uniqueTools: ActionDefinition[] = [];
  for (const t of tools) {
    if (!seen.has(t.tool.name)) {
      seen.add(t.tool.name);
      uniqueTools.push(t);
    }
  }
  return uniqueTools;
}

// ── go_to 工具 ──

function buildGoToTool(ctx: ToolBuildContext): ActionDefinition {
  const myHome = ctx.card.home;
  const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
  const otherLocations = ctx.allLocations
    .filter((l) => l.id !== ctx.state.locationId)
    .filter((l) => l.type !== "residential" || l.id === myHome)
    .map((l) => {
      const parts: string[] = [l.name];
      if (l.summary) parts[0] += `——${l.summary}`;
      if (l.id === workplace) parts[0] += "（你的工作地点）";
      if (l.id === myHome) parts[0] = `家——能休息、做饭、洗澡`;
      return `${l.id}: ${parts[0]}`;
    })
    .join("。");

  return {
    tool: {
      name: "go_to",
      description: "去别的地方。走路要花一点力气。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          location: {
            type: "string",
            description: otherLocations,
          },
        },
        required: ["location"],
      },
    },
    handler: (args, actx): ActionResult => ({
      description: `前往${args.location}`,
      effects: [
        { type: "location_change", targetId: actx.characterId, value: args.location as string },
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: -3 },
        { type: "need_change", targetId: actx.characterId, field: "bladder", delta: -3 },
      ],
      duration: 1,
    }),
  };
}

// ── talk 工具 ──

function nearbyNames(ctx: ToolBuildContext): string {
  return ctx.nearbyCharacters
    .map((c) => `${c.name}(${c.id})`)
    .join("、");
}

function buildTalkTool(ctx: ToolBuildContext): ActionDefinition {
  const who = nearbyNames(ctx);
  return {
    tool: {
      name: "talk",
      description: `跟在场的人说话。聊天挺好但也挺累的。在场：${who}。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么想说话（或不想）" },
          target: {
            type: "string",
            description: `对话对象：${who}`,
          },
          message: {
            type: "string",
            description: "你说出口的话。像正常人说话一样自然，一两句到三四句都可以。",
          },
          manner: {
            type: "string",
            description: "说话时的动作/表情（简短白描，如'低头搓着围裙'）",
          },
        },
        required: ["target", "message"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      const message = args.message as string;
      const manner = args.manner as string | undefined;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想和${target}说话，但对方不在这里`, effects: [], success: false };
      }
      const mannerText = manner ? `${manner}，` : "";
      return {
        description: `${mannerText}对${target}说：「${message}」`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 5 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 2 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -2 },
          { type: "need_change", targetId: target, field: "social", delta: 3 },
          { type: "inbox_message", targetId: target, fromName: actx.characterId, message },
        ],
      };
    },
  };
}

// ── comfort 工具 ──

function buildComfortTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "comfort",
      description: "安慰看起来不开心的人。安慰别人会消耗自己的精力。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          target: { type: "string", description: nearbyNames(ctx) },
          words: { type: "string", description: "安慰的话" },
        },
        required: ["target"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想安慰${target}，但对方不在这里`, effects: [], success: false };
      }
      return {
        description: `安慰${target}：${args.words ?? "一切都会好起来的"}`,
        effects: [
          { type: "need_change", targetId: target, field: "social", delta: 10 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 8 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -5 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -5 },
        ],
        duration: 2,
      };
    },
  };
}

// ── argue 工具 ──

function buildArgueTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "argue",
      description: "和某人吵架。能发泄一下，但很累，而且伤感情。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          target: { type: "string", description: nearbyNames(ctx) },
          reason: { type: "string", description: "吵架的原因" },
        },
        required: ["target", "reason"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想和${target}吵架，但对方不在`, effects: [], success: false };
      }
      return {
        description: `和${target}吵了起来：${args.reason}`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 5 },
          { type: "need_change", targetId: target, field: "fun", delta: -15 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -8 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 3 },
          { type: "relationship_change", targetId: target, delta: -15 },
        ],
        duration: 2,
      };
    },
  };
}

// ── 极端工具 ──

function buildBegTool(): ActionDefinition {
  return {
    tool: {
      name: "beg",
      description: "向路人乞讨。丢脸又难受，但能活下去。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      const amount = 5 + Math.floor(Math.random() * 11);
      return {
        description: `向路人乞讨，得到了 ${amount} 金币`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -10 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: -8 },
        ],
        duration: 1,
        _begAmount: amount,
      } as ActionResult & { _begAmount: number };
    },
  };
}

function buildStealTool(): ActionDefinition {
  return {
    tool: {
      name: "steal",
      description: "偷东西。你饿到不行了。可能会被抓。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      const amount = 20 + Math.floor(Math.random() * 21);
      const caught = Math.random() < 0.4;
      if (caught) {
        return {
          description: `偷东西被当场抓住了！`,
          effects: [],
          success: false,
        };
      }
      return {
        description: `悄悄拿走了 ${amount} 金币的东西`,
        effects: [],
        duration: 1,
        _stolenAmount: amount,
      } as ActionResult & { _stolenAmount: number };
    },
  };
}

// ── 地点工具（从 YAML 读取，自然语言描述） ──

/** 为地点工具生成自然语言描述 */
function describeLocationTool(lt: LocationTool, ctx: ToolBuildContext): string {
  // 基础描述来自 YAML
  let desc = lt.description;

  // 移除数值括号（如"（15金币）"），用自然语言替代
  desc = desc.replace(/（\d+金币）/, "");
  desc = desc.replace(/\(\d+金币\)/, "");

  // 金币提示用自然语言
  if (lt.cost) {
    if (lt.cost >= 15) desc += "。要花不少钱";
    else if (lt.cost >= 8) desc += "。要花一点钱";
    else desc += "。很便宜";
  }

  // 社交语境：如果有认识的人在，某些活动提一下
  if (ctx.nearbyCharacters.length > 0) {
    const names = ctx.nearbyCharacters.map((c) => c.name).join("和");
    if (lt.name === "eat" || lt.name === "drink" || lt.name === "drink_coffee") {
      desc += `。${names}也在`;
    }
  }

  // 工作/员工工具加上收入提示
  if (lt.name === "work") {
    desc += "。能赚钱，但又累又无聊";
  }
  if (lt.income) {
    desc += "。能赚一点钱";
  }

  // 特定工具的常识性代价
  if (lt.name === "swim") desc += "。很痛快，但游完浑身是盐得洗澡";
  if (lt.name === "drink" && ctx.location.id === "bar") desc += "。喝多了明天会头疼";
  if (lt.name === "cook") desc += "。便宜但费事，还会弄脏厨房";

  return desc;
}

// ── 物品工具 ──

function buildBuyTool(shop: ShopItem[], ctx: ToolBuildContext): ActionDefinition | null {
  // 只列出买得起的物品
  const affordable = shop.filter(s => ctx.gold >= s.price);
  if (affordable.length === 0) return null;

  const itemList = affordable.map(s => {
    const def = getItemDef(s.id);
    const desc = def?.description ? `——${def.description}` : "";
    return `${s.name}（${s.price}金币${desc}）`;
  }).join("、");

  return {
    tool: {
      name: "buy",
      description: `买东西带走。店里有：${itemList}`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          item: { type: "string", description: `要买的物品：${affordable.map(s => s.name).join("、")}` },
        },
        required: ["item"],
      },
    },
    handler: (args, actx): ActionResult => {
      const rawItem = args.item as string;
      // 支持 ID 和中文名：LLM 可能传 "notebook" 或 "笔记本"
      const resolved = resolveItem(rawItem);
      const shopItem = shop.find(s => s.id === rawItem || s.name === rawItem || (resolved && s.id === resolved.id));
      if (!shopItem) {
        return { description: `这里没有卖${rawItem}`, effects: [], success: false };
      }
      if (actx.gold < shopItem.price) {
        return { description: `钱不够买${shopItem.name}`, effects: [], success: false };
      }
      return {
        description: `买了${shopItem.name}`,
        effects: [],
        _buyItem: { defId: shopItem.id, price: shopItem.price },
      } as ActionResult & { _buyItem: { defId: string; price: number } };
    },
  };
}

/**
 * eat 工具：整合背包食物 + 当前地点商店食物。
 * 背包里的直接吃（免费），商店的买了直接吃（花钱）。
 */
function buildEatTool(
  bagFood: import("../world/item-types.js").ItemInstance[],
  shopFood: import("../world/item-types.js").ShopItem[],
  ctx: ToolBuildContext,
): ActionDefinition {
  const parts: string[] = [];

  if (bagFood.length > 0) {
    const bagList = bagFood.map(i => {
      const def = getItemDef(i.defId);
      const name = def?.name ?? i.defId;
      const from = i.giftedBy ? `（${i.giftedBy}给的）` : "";
      return `${name}${from}（免费）`;
    }).join("、");
    parts.push(`你身上有：${bagList}`);
  }

  if (shopFood.length > 0) {
    const shopList = shopFood.map(s => `${s.name}（${s.price}金币）`).join("、");
    parts.push(`店里有：${shopList}`);
  }

  return {
    tool: {
      name: "eat",
      description: `吃点东西。${parts.join("。")}`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          item: { type: "string", description: "要吃/喝什么" },
        },
        required: ["item"],
      },
    },
    handler: (args, actx): ActionResult => {
      const rawItem = args.item as string;
      // 支持 ID 和中文名
      const def = resolveItem(rawItem);
      if (!def) {
        return { description: `不知道${rawItem}是什么`, effects: [], success: false };
      }
      const itemId = def.id; // 统一使用标准 ID
      const effects = def.effects
        ? Object.entries(def.effects).map(([field, delta]) => ({
            type: "need_change" as const,
            targetId: actx.characterId,
            field,
            delta,
          }))
        : [];

      // 判断来源：背包还是商店
      const inBag = (ctx.state.inventory ?? []).some(i => i.defId === itemId);
      const shopItem = (ctx.location.shop ?? []).find(s => s.id === itemId);

      if (inBag) {
        return {
          description: `吃了${def.name}`,
          effects,
          duration: 2,
          _useItem: itemId,
        } as ActionResult & { _useItem: string };
      } else if (shopItem) {
        return {
          description: `买了${def.name}吃`,
          effects,
          duration: 2,
          _buyItem: { defId: itemId, price: shopItem.price },
          _useItem: itemId, // 买了立刻吃，不入背包
          _eatImmediate: true,
        } as ActionResult & { _buyItem: { defId: string; price: number }; _useItem: string; _eatImmediate: boolean };
      } else {
        return { description: `这里没有${def.name}`, effects: [], success: false };
      }
    },
  };
}

/** cook 工具：消耗食材，产出家常饭 */
function buildCookTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "cook",
      description: "用食材做饭。便宜但费事，还会弄脏厨房。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      if (!hasItem(ctx.state.inventory ?? [], "ingredients")) {
        return { description: "想做饭但发现没有食材了", effects: [], success: false };
      }
      return {
        description: "在家做了一顿饭",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "hunger", delta: 60 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 5 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -8 },
          { type: "need_change", targetId: actx.characterId, field: "hygiene", delta: -5 },
        ],
        duration: 3,
        _useItem: "ingredients",
      } as ActionResult & { _useItem: string };
    },
  };
}

function buildGiveTool(ctx: ToolBuildContext): ActionDefinition {
  const itemList = ctx.state.inventory.map(i => {
    const def = getItemDef(i.defId);
    return def?.name ?? i.defId;
  }).join("、");
  const who = nearbyNames(ctx);

  return {
    tool: {
      name: "give",
      description: `把东西给别人。你有：${itemList}。在场：${who}`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么想送" },
          target: { type: "string", description: `给谁：${who}` },
          item: { type: "string", description: "给什么" },
        },
        required: ["target", "item"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      const rawItem = args.item as string;
      const def = resolveItem(rawItem);
      const itemId = def?.id ?? rawItem;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `${target}不在这里`, effects: [], success: false };
      }
      if (!hasItem(ctx.state.inventory ?? [], itemId)) {
        return { description: `你没有${def?.name ?? rawItem}`, effects: [], success: false };
      }
      return {
        description: `把${def?.name ?? rawItem}给了${target}`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 5 },
          { type: "need_change", targetId: target, field: "social", delta: 10 },
        ],
        _giveItem: { defId: itemId, targetId: target },
      } as ActionResult & { _giveItem: { defId: string; targetId: string } };
    },
  };
}

/** 物品启用的工具（如 notebook → journal） */
function buildItemEnabledTool(toolId: string, itemName: string, ctx: ToolBuildContext): ActionDefinition | null {
  const toolDefs: Record<string, { description: string; effects: Record<string, number>; duration: number }> = {
    journal: { description: `拿出${itemName}写点东西`, effects: { fun: 8, social: -2 }, duration: 2 },
    practice_music: { description: `弹弹吉他`, effects: { fun: 10, energy: -8 }, duration: 4 },
    fish: { description: `拿出鱼竿钓鱼。需要耐心`, effects: { fun: 12, energy: -5 }, duration: 6 },
    draw: { description: `画点东西`, effects: { fun: 10, energy: -5 }, duration: 3 },
    photograph: { description: `拍几张照片`, effects: { fun: 8, energy: -2 }, duration: 1 },
  };

  const def = toolDefs[toolId];
  if (!def) return null;

  return {
    tool: {
      name: toolId,
      description: def.description,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => ({
      description: def.description,
      effects: Object.entries(def.effects).map(([field, delta]) => ({
        type: "need_change" as const,
        targetId: actx.characterId,
        field,
        delta,
      })),
      duration: def.duration,
    }),
  };
}

// ── 地点工具（从 YAML 读取，自然语言描述） ──

function buildLocationTool(lt: LocationTool, ctx: ToolBuildContext): ActionDefinition | null {
  // 检查条件
  if (lt.condition) {
    if (lt.condition === "isWorkplace") {
      const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
      if (workplace && ctx.location.id !== workplace) {
        return null;
      }
    } else if (lt.condition.includes("<")) {
      const match = lt.condition.match(/(\w+)\s*<\s*(\d+)/);
      if (match) {
        const field = match[1]!;
        const threshold = parseInt(match[2]!, 10);
        const isNight = ctx.hour !== undefined && (ctx.hour >= 22 || ctx.hour < 5);
        const isSleepTool = lt.name === "sleep";
        if (isSleepTool && isNight) {
          // 深夜总是可以睡觉
        } else if (ctx.state.needs[field] !== undefined && ctx.state.needs[field] >= threshold) {
          return null;
        }
      }
    }
  }

  // 检查金币
  if (lt.cost && ctx.gold < lt.cost) return null;

  // 构建自然语言描述
  const desc = describeLocationTool(lt, ctx);

  return {
    tool: {
      name: lt.name,
      description: desc,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      const effects = Object.entries(lt.effects).map(([field, delta]) => ({
        type: "need_change" as const,
        targetId: actx.characterId,
        field,
        delta,
      }));
      const result: ActionResult & { _cost?: number; _workerIncome?: number } = {
        description: lt.description.replace(/（.*?）/, ""),
        effects,
        duration: lt.duration ?? 1,
      };
      if (lt.cost) result._cost = lt.cost;
      if (lt.income) result._workerIncome = lt.income;
      return result;
    },
  };
}
