/**
 * Tool Builder — 情境工具系统
 *
 * 根据角色当前的地点、附近的人、身体状态动态组装可用工具列表。
 * 工具不是全局菜单，而是环境的可供性（affordance）。
 */

import type { ToolDefinition } from "../providers/types.js";
import type { ActionDefinition, ActionResult, ActionContext } from "../actions/types.js";
import type { CharacterState, Location, LocationTool } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";
import { getWorkIncome } from "../world/economy.js";

export interface ToolBuildContext {
  state: CharacterState;
  card: CharacterCard;
  location: Location;
  nearbyCharacters: Array<{ id: string; name: string }>;
  allLocations: Location[];
  gold: number;
}

/**
 * 为角色动态组装当前可用的工具列表（ToolDefinition[] + ActionDefinition[]）。
 *
 * 返回的 ActionDefinition 同时包含 tool 定义（传给 LLM）和 handler（执行逻辑）。
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

  // 3. 社交工具（附近有人时）
  if (ctx.nearbyCharacters.length > 0) {
    tools.push(buildTalkTool(ctx));
    tools.push({
      tool: {
        name: "comfort",
        description: "安慰在场看起来不开心的人",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: targetDescription(ctx) },
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
            { type: "need_change", targetId: target, field: "happiness", delta: 15 },
            { type: "need_change", targetId: target, field: "social", delta: 10 },
            { type: "need_change", targetId: actx.characterId, field: "social", delta: 8 },
          ],
          duration: 2,
        };
      },
    });

    // argue 只在心情低时浮现
    if (ctx.state.needs.happiness < 30) {
      tools.push({
        tool: {
          name: "argue",
          description: "和某人吵架——你心情很差，忍不住想发火",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: targetDescription(ctx) },
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
              { type: "need_change", targetId: actx.characterId, field: "happiness", delta: -15 },
              { type: "need_change", targetId: target, field: "happiness", delta: -15 },
              { type: "need_change", targetId: actx.characterId, field: "social", delta: 5 },
            ],
            duration: 2,
          };
        },
      });
    }
  }

  // 4. hobby（只在地点没有提供 hobby 工具时才添加默认版本）
  const hasHobby = tools.some((t) => t.tool.name === "hobby");
  if (!hasHobby) {
    tools.push({
      tool: {
        name: "hobby",
        description: "做自己喜欢的事：发呆、想事情、看风景、写笔记",
        parameters: { type: "object", properties: {} },
      },
      handler: (_args, actx): ActionResult => ({
        description: "做了一会儿自己喜欢的事",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "happiness", delta: 10 },
        ],
        duration: 2,
      }),
    });
  }

  // 5. 极端状态工具（平时隐藏）
  if (ctx.gold === 0) {
    tools.push({
      tool: {
        name: "beg",
        description: "向路人乞讨一点钱——你走投无路了",
        parameters: { type: "object", properties: {} },
      },
      handler: (_args, actx): ActionResult => {
        const amount = 5 + Math.floor(Math.random() * 11);
        return {
          description: `向路人乞讨，得到了 ${amount} 金币`,
          effects: [
            { type: "need_change", targetId: actx.characterId, field: "happiness", delta: -10 },
          ],
          duration: 1,
          _begAmount: amount,
        } as ActionResult & { _begAmount: number };
      },
    });
  }
  if (ctx.gold === 0 && ctx.state.needs.hunger < 20) {
    tools.push({
      tool: {
        name: "steal",
        description: "偷东西——你饿到不行了，顾不了那么多",
        parameters: { type: "object", properties: {} },
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
    });
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

// ── go_to 工具（动态参数） ──

function buildGoToTool(ctx: ToolBuildContext): ActionDefinition {
  const myHome = ctx.card.home;
  const otherLocations = ctx.allLocations
    .filter((l) => l.id !== ctx.state.locationId)
    // 只显示公共地点 + 自己的家（不能随便去别人家）
    .filter((l) => l.type !== "residential" || l.id === myHome)
    .map((l) => `${l.id}(${l.name}${l.summary ? ' — ' + l.summary : ''})`)
    .join("\n  ");

  return {
    tool: {
      name: "go_to",
      description: "移动到小镇中的其他地方。",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: `你可以去：\n  ${otherLocations}`,
          },
        },
        required: ["location"],
      },
    },
    handler: (args, actx): ActionResult => ({
      description: `前往${args.location}`,
      effects: [
        { type: "location_change", targetId: actx.characterId, value: args.location as string },
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: -2 },
      ],
      duration: 1,
    }),
  };
}

// ── talk 工具（动态参数） ──

function targetDescription(ctx: ToolBuildContext): string {
  return ctx.nearbyCharacters
    .map((c) => `${c.name}(${c.id})`)
    .join(" 或 ");
}

function buildTalkTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "talk",
      description: "在当前地点当面对某人说话。在场的人也可能注意到。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: `对话对象：${targetDescription(ctx)}`,
          },
          message: {
            type: "string",
            description: "你说出口的话（只写台词，不写心理描写）。像正常人说话一样，一两句到三四句都可以，不要太长。",
          },
          manner: {
            type: "string",
            description: "说话时的动作/表情（可选，简短白描，如'低头搓着围裙'）",
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
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 3 },
          { type: "need_change", targetId: target, field: "social", delta: 1 },
          { type: "inbox_message", targetId: target, fromName: actx.characterId, message },
        ],
      };
    },
  };
}

// ── 地点工具 ──

function buildLocationTool(lt: LocationTool, ctx: ToolBuildContext): ActionDefinition | null {
  // 检查条件
  if (lt.condition) {
    if (lt.condition === "isWorkplace") {
      // 只有在自己工作的地点才能 work
      const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
      if (workplace && ctx.location.id !== workplace) {
        return null; // 不是自己的工作地点，不显示 work
      }
    } else if (lt.condition.includes("<")) {
      const match = lt.condition.match(/(\w+)\s*<\s*(\d+)/);
      if (match) {
        const field = match[1] as keyof typeof ctx.state.needs;
        const threshold = parseInt(match[2]!, 10);
        if (ctx.state.needs[field] !== undefined && ctx.state.needs[field] >= threshold) {
          return null; // 条件不满足，不显示
        }
      }
    }
  }

  // 检查金币
  if (lt.cost && ctx.gold < lt.cost) return null;

  // 构建 ActionDefinition
  const costHint = lt.cost ? `（${lt.cost}金币）` : "";
  return {
    tool: {
      name: lt.name,
      description: `${lt.description}${costHint}`,
      parameters: { type: "object", properties: {} },
    },
    handler: (_args, actx): ActionResult => {
      const effects = Object.entries(lt.effects).map(([field, delta]) => ({
        type: "need_change" as const,
        targetId: actx.characterId,
        field,
        delta,
      }));
      const result: ActionResult & { _cost?: number } = {
        description: lt.description.replace(/（.*?）/, ""),
        effects,
        duration: lt.duration ?? 1,
      };
      if (lt.cost) result._cost = lt.cost;
      return result;
    },
  };
}
