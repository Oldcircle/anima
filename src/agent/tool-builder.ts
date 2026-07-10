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
import { getWorkIncome, effectivePrice, financeBand, dailyUpkeep } from "../world/economy.js";
import { inviteOutAction, shareSecretAction } from "../actions/relationship-actions.js";
import { getItemDef, hasItem, resolveItem } from "../world/item-registry.js";
import { argueFrictionGateEnabled, argueFrictionIncludesNegativeLevel, getBreakLevel } from "./break-config.js";
import type { ShopItem } from "../world/item-types.js";
import { parseAppointmentTime, describeAppointmentTime } from "../world/appointments.js";

export interface ToolBuildContext {
  state: CharacterState;
  card: CharacterCard;
  location: Location;
  nearbyCharacters: Array<{ id: string; name: string }>;
  talkCooldownTargets?: string[];
  allLocations: Location[];
  gold: number;
  /** 当前游戏时间（小时） */
  hour?: number;
  /** 当前 tick（菜园成熟判定等慢变量用；不要把它写进任何工具描述——缓存纪律） */
  tick?: number;
  /** 当前季节（季节市场价格用） */
  season?: import("../world/types.js").Season;
  /** 关系管理器（用于条件浮现关系工具） */
  relationships?: import("../world/relationships.js").RelationshipManager;
  /** 角色 ID → 显示名映射（用于 go_to 地点人物描述） */
  characterNames?: Map<string, string>;
  /** 当前剧本阶段 (N6.4 phase gating) */
  activePhase?: string;
  /** 剧本提供的 phase-specific 工具集 */
  phaseTools?: ActionDefinition[];
}

/**
 * 为角色动态组装当前可用的工具列表。
 *
 * ⚠️ 缓存纪律（prompt caching is everything）：工具表是 LLM 请求前缀的一部分，
 * 集合与描述只允许随「角色 × 地点」这种慢变量变化，禁止内嵌每 tick 抖动的状态
 * （在场者名单、营业状态、金币、库存、需求数值）。这些动态信息一律下沉到
 * user prompt 末尾的 buildEnvironmentSnapshot()；可用性改在执行期校验，
 * 失败给自然语言反馈交由 tool-feedback 纠偏。低频翻转的条件浮现
 * （argue/beg/steal/物品工具/cook）保留——偶尔断一次前缀可以接受。
 */
export function buildToolList(ctx: ToolBuildContext): ActionDefinition[] {
  const tools: ActionDefinition[] = [];

  // 1. 通用工具：go_to（永远可用）
  tools.push(buildGoToTool(ctx));

  // 2. 地点工具（从当前地点 YAML 读取；营业/需求/金币门槛在执行期校验）
  if (ctx.location.tools) {
    for (const lt of ctx.location.tools) {
      const action = buildLocationTool(lt, ctx);
      if (action) tools.push(action);
    }
  }

  // 2b. 员工工具（在自己工作地点时；体力门槛在执行期校验）
  const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
  if (workplace && ctx.location.id === workplace && ctx.location.workerTools) {
    for (const wt of ctx.location.workerTools) {
      const action = buildLocationTool(wt, ctx, { isWorkerTool: true });
      if (action) tools.push(action);
    }
  }

  // 2b2. 员工制作工具（在自己工作地点 + 有 shop；体力门槛在执行期校验）
  if (workplace && ctx.location.id === workplace && ctx.location.shop && ctx.location.shop.length > 0) {
    tools.push(buildPrepareTool(ctx.location.shop, ctx));
  }

  // 2c. 商店工具（地点有 shop 即声明；营业/钱够/库存在执行期校验）
  if (ctx.location.shop && ctx.location.shop.length > 0) {
    tools.push(buildBuyTool(ctx.location.shop, ctx));
  }

  // 2d. eat：恒定声明（有没有吃的在执行期判定，具体清单见环境快照）
  tools.push(buildEatTool(ctx));

  // 2e. give：恒定声明（背包与在场者在执行期校验）
  tools.push(buildGiveTool(ctx));

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

  // 2g1b. sell：杂货店回收旧货（物品↔金币闭环：吉他相机不再是死钱，收的菜也能换钱）
  if (ctx.location.id === "shop") {
    tools.push(buildSellTool(ctx));
  }

  // 2g1c. take_medicine：身上有药且正病着——生病要治，拖着每 tick 掉精力
  if (
    hasItem(ctx.state.inventory ?? [], "medicine") &&
    ctx.state.moodlets?.some((m) => m.reason.includes("着凉"))
  ) {
    tools.push(buildTakeMedicineTool());
  }

  // 2g2. 菜园（世界可改造）：在农田时按地块状态浮现。农田低频到访，
  // 工具集随「有没有种/熟没熟」变化属于可接受的低频前缀抖动（同 item 工具）。
  if (ctx.location.id === "farm") {
    const garden = ctx.state.garden;
    if (!garden && hasItem(ctx.state.inventory ?? [], "vegetable_seeds")) {
      tools.push(buildPlantCropTool());
    }
    if (garden) {
      if (gardenIsMature(garden, ctx.tick ?? 0)) tools.push(buildHarvestCropTool());
      else tools.push(buildTendCropTool());
    }
  }

  // 2h. read：在图书馆时无条件可用（图书馆有书）— 后续应迁移到 YAML
  if (ctx.location.id === "library" && !tools.some(t => t.tool.name === "read")) {
    tools.push({
      tool: { name: "read", description: "从书架上拿本书看。安静但久坐会累，而且一个人看书会有点孤独。", parameters: { type: "object", properties: { thought: { type: "string", description: "你在想什么" } } } },
      handler: (_args, actx): ActionResult => ({
        description: "在图书馆看书",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 20 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -5 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: -3 },
        ],
        duration: 4,
        observableState: "抱着一本书看得有些入神，几乎没注意周围。",
      }),
    });
  }

  // 3. 社交工具：恒定声明（对方在不在执行期校验；"附近没人"user prompt 里已写明）
  tools.push(buildTalkTool(ctx));
  tools.push(buildComfortTool(ctx));
  tools.push(buildArrangeMeetTool(ctx));

  // argue 保留条件浮现（破线设计的一部分）：负面情绪、fun 极低、或与在场某人有关系摩擦。
  // 情绪窗口以小时计，属于可接受的低频前缀抖动。
  // 关系摩擦门（P4）破解"必须先吵一次才能吵"的鸡生蛋：angry moodlet 只由 argue/steal 自己产生，
  // 若只认 mood/fun，第一次 argue 结构性不可达。off 档 argueFrictionGateEnabled()=false → 回归旧行为。
  if (ctx.nearbyCharacters.length > 0) {
    const dominantMood = ctx.state.moodlets?.length
      ? [...ctx.state.moodlets].sort((a, b) => b.intensity - a.intensity)[0]
      : undefined;
    const hasNegativeMood = dominantMood && ["sad", "angry", "anxious"].includes(dominantMood.emotion);
    const lowFun = ctx.state.needs.fun !== undefined && ctx.state.needs.fun < 30;
    let hasFriction = false;
    if (argueFrictionGateEnabled() && ctx.relationships) {
      for (const nearby of ctx.nearbyCharacters) {
        const rel = ctx.relationships.get(ctx.card.id, nearby.id);
        if (rel.type === "rival" || rel.grudge || rel.bond === "rival" || rel.bond === "ex"
            || (argueFrictionIncludesNegativeLevel() && rel.level < 0)) {
          hasFriction = true;
          break;
        }
      }
    }
    // 挑明 intent 门（7 天实测实锤）：argue 兜底注入"把话挑明"时 21/21 次 argue 都不在菜单——
    // 疙瘩攒满但关系 level 还是正的（如 L↔月 =7），上面的摩擦门全不认。
    // intent 说挑明、菜单就得上菜：正在生效的挑明 intent 且对象在场 → argue 浮现。
    const confrontIntent = ctx.state.currentIntent;
    const hasConfrontNudge = !!confrontIntent
      && confrontIntent.summary.includes("挑明")
      && (ctx.tick === undefined || confrontIntent.expiresAt > ctx.tick)
      && (!confrontIntent.targetId || ctx.nearbyCharacters.some((n) => n.id === confrontIntent.targetId));
    if (hasNegativeMood || lowFun || hasFriction || hasConfrontNudge) {
      tools.push(buildArgueTool(ctx));
    }
  }

  // 3b. 关系深度工具：达标与否看"是否存在达标关系"（角色级慢变量），对方在不在执行期校验
  if (ctx.relationships) {
    const rels = ctx.relationships.getRelationshipsOf(ctx.card.id);
    if (rels.some(({ relationship: r }) => r.level >= 40)) tools.push(inviteOutAction);
    if (rels.some(({ relationship: r }) => r.level >= 70)) tools.push(shareSecretAction);
  }

  // 4. 绝境阶梯（平时隐藏）：生存压力把人往底线外推——每一档都有尊严代价。
  // 浮现门槛按财务体感（AUDIT：旧门槛 gold===0 在现行经济下半天窗口不可达）。
  {
    const band = financeBand(ctx.gold, dailyUpkeep(ctx.state.life?.income));
    const desperate = band === "destitute" || band === "broke"; // 手头的钱撑不过两天
    const hunger = ctx.state.needs.hunger ?? 100;
    const age = ctx.state.life?.age ?? ctx.card.life?.age ?? ctx.card.age ?? 20;
    if (desperate) {
      tools.push(buildBegTool());
      if (age >= 18) tools.push(buildSellBloodTool(ctx));
      if (ctx.nearbyCharacters.length > 0) tools.push(buildBorrowMoneyTool(ctx));
    }
    // 还钱：债主就在眼前且手头够——账要还，人情才续得上
    const payableDebt = (ctx.state.debts ?? []).find(
      (d) => ctx.nearbyCharacters.some((n) => n.id === d.lenderId) && ctx.gold >= d.amount,
    );
    if (payableDebt) tools.push(buildRepayDebtTool());
    if (desperate && hunger < 30) {
      tools.push(buildScavengeTool());
    }
    if (band === "destitute" && hunger < 20) {
      tools.push(buildStealTool(ctx));
    }
    // 陪酒：成年 + 在酒吧 + 晚间 + 走投无路 + 破线档（off 档的治愈小镇没有这条路）
    if (age >= 18 && ctx.location.id === "bar" && (ctx.hour ?? 12) >= 19 && desperate && getBreakLevel() !== "off") {
      tools.push(buildHostessTool());
    }
  }

  // 5. Phase-specific 工具 (N6.4)：仅在 active_phase 在剧本白名单中时浮现。
  // 带 emerge 谓词的工具（kira_strike 等）再过一道条件浮现（持有物/时段/地点，低频翻转）。
  if (ctx.activePhase && ctx.phaseTools && ctx.phaseTools.length > 0) {
    for (const t of ctx.phaseTools) {
      if (t.emerge && !t.emerge(ctx)) continue;
      tools.push(t);
    }
  }

  // 6. do_nothing 兜底（永远可用）
  // 当工具池贫瘠（如自家房间只有 go_to）或前一次行动失败时，让 LLM 总有"什么都不做"的出路，
  // 避免被迫反复 go_to 兜圈子。参考 Claude Code 的 "stay where you are" 容错思路。
  tools.push(buildDoNothingTool());

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

// ── do_nothing 工具 ──

function buildDoNothingTool(): ActionDefinition {
  return {
    tool: {
      name: "do_nothing",
      description: "什么都不做，发会儿呆/等一等。当你不知道做什么、周围没什么合适的事可做、或刚刚行动失败暂时缓一下时，选这个比胡乱重试好。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, _actx): ActionResult => ({
      description: "发了一会儿呆",
      effects: [],
      duration: 1,
      observableState: "若有所思地停了下来，没特别在做什么。",
    }),
  };
}

// ── go_to 工具 ──

function buildGoToTool(ctx: ToolBuildContext): ActionDefinition {
  const myHome = ctx.card.home;
  const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
  const allowedLocations = ctx.allLocations
    .filter((l) => l.id !== ctx.state.locationId)
    .filter((l) => l.type !== "residential" || l.id === myHome);
  // 缓存纪律：描述只含慢变量（地点名/summary/工作地标注）。谁在哪、是否打烊
  // 这类每 tick 抖动的信息在 user prompt 的环境快照里，不进工具描述。
  const otherLocations = allowedLocations
    .map((l) => {
      if (l.id === myHome) return `家——能休息、做饭、洗澡`;
      let desc = l.name;
      if (l.summary) desc += `——${l.summary}`;
      if (l.id === workplace) desc += "（你的工作地点）";
      return desc;
    })
    .join("。");

  // 当前位置锚点：让 LLM 在 token 级看到自己在哪，覆盖"误调当前地点"。
  const currentAnchor = `你当前在【${ctx.location.name}】(id=${ctx.location.id})。不要 go_to 到当前地点，也不要传"家"作为同义词——在家就直接做想做的事。`;
  return {
    tool: {
      name: "go_to",
      description: `${currentAnchor} 去别的地方。走路要花一点力气。各地方现在有谁、是否营业，看下方环境快照。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          location: {
            type: "string",
            description: `可去的地点（不要传你当前所在的【${ctx.location.name}】）：${otherLocations}`,
          },
        },
        required: ["location"],
      },
    },
    handler: (args, actx): ActionResult => {
      const rawLoc = args.location as string;
      // "家"/"home" 且已在家：优雅降级为"原地歇会儿"而不是报错。
      // 半天模拟实测（2026-07-03 两轮）：报错版（无论"没有这个地方"还是"你就在家里"）
      // 都教不会模型——重试仍会再选 go_to 家，白烧 1-2 次 LLM 调用。
      // 参考 Claude Code 的 stay-where-you-are 容错：模型想"回家歇着"，那就让它就地歇着，
      // 记忆里留下自然叙事，重复倾向交给 recentActions streak 提示去纠。
      if ((rawLoc === "家" || rawLoc === "回家" || rawLoc === "home") && myHome === ctx.state.locationId) {
        return {
          description: "本来想着回家，回过神来发现自己就在家里，索性就近歇了会儿",
          effects: [],
          duration: 1,
          observableState: "在家里慢悠悠地待着，没什么特别要做的。",
        };
      }
      // 支持 ID、中文名、描述文本：LLM 可能传 "cafe"、"咖啡馆"、"海风面包坊——买面包、吃东西（你的工作地点）。"
      const resolveLocation = (input: string) => {
        // "家"/"回家"/"home"：在家时不再映射到当前位置（避免软提示被忽略），让上层报 unknown_location 硬错误
        if (input === "家" || input === "回家" || input === "home") {
          if (myHome === ctx.state.locationId) return undefined;
          return ctx.allLocations.find(l => l.id === myHome);
        }
        // 1. 精确匹配 ID 或名字
        const exact = ctx.allLocations.find(l => l.id === input || l.name === input);
        if (exact) return exact;
        // 2. LLM 可能把整段描述当作 location 传入，截取"——"前的名字重试
        const nameOnly = input.split("——")[0]!.trim();
        if (nameOnly !== input) {
          const byName = ctx.allLocations.find(l => l.id === nameOnly || l.name === nameOnly);
          if (byName) return byName;
        }
        // 3. 模糊匹配：输入包含地点名，或地点名包含输入
        return ctx.allLocations.find(l => input.includes(l.name) || l.name.includes(input));
      };
      const target = resolveLocation(rawLoc);
      if (target && target.id === ctx.state.locationId) {
        // 同上：go_to 当前位置不再报错，降级为原地停留
        return {
          description: `本来想去${ctx.location.name}，回过神来发现自己就在这儿，索性就地待了会儿`,
          effects: [],
          duration: 1,
          observableState: "在原地慢悠悠地待着，像在想接下来做什么。",
        };
      }
      if (!target || !allowedLocations.some(l => l.id === target.id)) {
        return {
          description: `想去${rawLoc}，但你知道镇上并没有这个地方`,
          effects: [],
          success: false,
        };
      }
      return {
        description: `前往${target.name}`,
        effects: [
          { type: "location_change", targetId: actx.characterId, value: target.id },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -3 },
          { type: "need_change", targetId: actx.characterId, field: "bladder", delta: -3 },
        ],
        duration: 1,
        observableState: `刚走进${target.name}，像是在找个能待下来的位置。`,
      };
    },
  };
}

// ── talk 工具 ──

/** 营业时间判断：openHours 数据早就在 YAML 里，此前零消费——深夜也能买拿铁 */
export function isLocationOpen(loc: Location, hour?: number): boolean {
  if (hour === undefined || !loc.openHours) return true;
  const { open, close } = loc.openHours;
  if (open === close) return true;
  if (open < close) return hour >= open && hour < close;
  return hour >= open || hour < close; // 跨夜营业（酒吧 17-2）
}

function nearbyDisplayName(ctx: ToolBuildContext, id: string): string {
  return ctx.nearbyCharacters.find((c) => c.id === id)?.name ?? id;
}

function truncateVisibleText(text: string, maxChars = 18): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "…";
}

function describeLocationObservableState(lt: LocationTool, ctx: ToolBuildContext): string | undefined {
  switch (lt.name) {
    case "sleep": return "已经睡着了，呼吸慢慢平稳下来。";
    case "wash": return "暂时不在，大概是在洗漱。";
    case "use_toilet": return "刚起身离开了一会儿，像是去洗手间了。";
    case "nap": return "靠着一旁短暂打了个盹。";
    case "walk":
      return ctx.location.id === "beach"
        ? "沿着海边慢慢走着，像在想事情。"
        : "在附近慢慢散步，没有急着去哪里。";
    case "sit": return "找了个地方坐下，安静地发着呆。";
    case "rest": return "安静地坐在一边休息，不太想被打扰。";
    case "tidy_up": return "正在屋里收拾东西，把散落的物件一件件归回原位。";
    case "swim": return "在海水里来回游着，动作舒展开来。";
    case "stargaze": return "抬头望着天，像是把注意力都放远了。";
    case "collect_shells": return "弯着腰在沙地上认真挑拣贝壳。";
    case "explore": return "在四周慢慢逛着，时不时停下来看看。";
    case "collect_herbs": return "蹲下来翻看草叶，像在找能用的植物。";
    case "buy_supplies": return "手里抱着刚买的一袋东西。";
    case "arrange_flowers": return "低头修剪花枝，动作很轻。";
    case "serve_customer":
      return ctx.location.id === "bakery"
        ? "在柜台边招呼客人、递面包。"
        : "在店里招呼客人、收拾桌面。";
    case "make_coffee": return "在吧台后做咖啡，手边飘着热气。";
    case "clean_table": return "弯着腰擦桌子，把杯盘一点点收好。";
    case "knead_dough": return "手上沾着面粉，专心揉着面团。";
    case "bake": return "守在烤箱边，不时朝里面看一眼。";
    case "shelve_books": return "抱着一摞书，在书架间来回整理。";
    case "help_reader": return "压低声音给人指路，语气很耐心。";
    case "read": return "抱着一本书看得有些入神。";
    default: return undefined;
  }
}

function buildTalkTool(ctx: ToolBuildContext): ActionDefinition {
  // 缓存纪律：描述静态。谁在场、社交疲劳感都在 user prompt（"你现在看见了谁"/"身体感受"）里。
  return {
    tool: {
      name: "talk",
      description: `跟在场的人说话。聊天挺好但也挺累的。在场有谁看下方"你现在看见了谁"。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么想说话（或不想）" },
          target: {
            type: "string",
            description: `对话对象的角色 ID（必须此刻在场）`,
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
      // 用执行时的在场名单校验（actx），不是决策开始时的快照（ctx）——
      // 并行决策下对方可能同 tick 已离开，旧校验会让角色对着空气说话还留下记忆
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想和${target}说话，但对方已经不在这里了`, effects: [], success: false };
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
        observableState: `${manner ? `${manner}，` : ""}正和${nearbyDisplayName(ctx, target)}说话${message ? `，像是提到「${truncateVisibleText(message, 14)}」` : ""}。`,
      };
    },
  };
}

// ── arrange_meet 工具（约定系统）──

function buildArrangeMeetTool(ctx: ToolBuildContext): ActionDefinition {
  // 只能约在公共地点（不能约在别人家）。地点清单是剧本级静态信息，可以进描述。
  const publicLocations = ctx.allLocations.filter((l) => l.type !== "residential");
  const locationList = publicLocations.map((l) => l.name).join("、");

  return {
    tool: {
      name: "arrange_meet",
      description: `和在场的人约个时间地点见面（比如"明天中午在咖啡馆见"）。说定了就是承诺——到时候不去，对方会记住的。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么想约" },
          target: { type: "string", description: `约谁（角色 ID，必须此刻在场）` },
          location: { type: "string", description: `约在哪（公共地点）：${locationList}` },
          when: { type: "string", description: `什么时候。用"今天18:00"、"明天12:00"或"明天中午"这样的说法` },
          activity: { type: "string", description: "约好做什么（可选，如'一起吃午饭'）" },
        },
        required: ["target", "location", "when"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      const rawLocation = (args.location as string | undefined)?.trim() ?? "";
      const when = (args.when as string | undefined)?.trim() ?? "";
      const activity = (args.activity as string | undefined)?.trim() || undefined;

      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想和${target}约时间，但对方不在这里`, effects: [], success: false };
      }
      // 地点宽容匹配（复用 go_to 的思路：ID、名字、包含关系）
      const loc = publicLocations.find((l) => l.id === rawLocation || l.name === rawLocation)
        ?? publicLocations.find((l) => rawLocation.includes(l.name) || l.name.includes(rawLocation));
      if (!loc) {
        return { description: `想约在${rawLocation || "（没说地方）"}，但那不是个能约见面的地方`, effects: [], success: false };
      }
      const atTick = parseAppointmentTime(when, actx.tick);
      if (atTick === undefined) {
        return {
          description: `想和${nearbyDisplayName(ctx, target)}约见面，但没说清什么时候（用"明天中午"或"今天18:00"这样的说法）`,
          effects: [],
          success: false,
        };
      }
      const timeText = describeAppointmentTime(atTick, actx.tick);
      const activityText = activity ? `，${activity}` : "";
      return {
        description: `和${nearbyDisplayName(ctx, target)}约好了${timeText}在${loc.name}见面${activityText}`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 5 },
          { type: "need_change", targetId: target, field: "social", delta: 5 },
          { type: "inbox_message", targetId: target, fromName: actx.characterId, message: `那说定了，${timeText}在${loc.name}见${activityText}。` },
        ],
        duration: 1,
        observableState: `正和${nearbyDisplayName(ctx, target)}商量着什么时候碰面。`,
        _appointment: { targetId: target, locationId: loc.id, atTick, activity },
      } as ActionResult & { _appointment: { targetId: string; locationId: string; atTick: number; activity?: string } };
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
          target: { type: "string", description: "安慰谁（角色 ID，必须此刻在场）" },
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
      const words = (args.words as string | undefined)?.trim() || "一切都会好起来的";
      const selfName = ctx.card.name;
      return {
        description: `安慰${target}：${words}`,
        effects: [
          { type: "need_change", targetId: target, field: "social", delta: 10 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 8 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -5 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -5 },
          // 被安慰的人要听到安慰的话（能回应），并记得这份好意
          { type: "inbox_message", targetId: target, fromName: selfName, message: `（放轻了声音）${words}` },
          { type: "relationship_change", targetId: target, delta: 3 },
          { type: "moodlet", targetId: target, emotion: "grateful", intensity: 3, reason: `${selfName}安慰了自己`, durationTicks: 10 },
        ],
        duration: 2,
        observableState: `正压低声音安慰${nearbyDisplayName(ctx, target)}，语气放得很轻。`,
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
          target: { type: "string", description: "跟谁吵（角色 ID，必须此刻在场）" },
          reason: { type: "string", description: "吵架的原因" },
          words: { type: "string", description: "你吵架时说出口的话（对方会听到并可能还嘴）" },
        },
        required: ["target", "reason"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想和${target}吵架，但对方不在`, effects: [], success: false };
      }
      const reason = args.reason as string;
      const words = (args.words as string | undefined)?.trim() || reason;
      const selfName = ctx.card.name;
      return {
        description: `和${target}吵了起来：${reason}`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 5 },
          { type: "need_change", targetId: target, field: "fun", delta: -15 },
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -8 },
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 3 },
          { type: "relationship_change", targetId: target, delta: -15 },
          // 对方必须知道自己被吵了：进 inbox（触发反应轮，能还嘴）
          { type: "inbox_message", targetId: target, fromName: selfName, message: `（语气冲）${words}` },
          // 双方情绪都被点燃，吵完不会立刻烟消云散
          { type: "moodlet", targetId: target, emotion: "angry", intensity: 4, reason: `被${selfName}当面呛了一顿`, durationTicks: 12 },
          { type: "moodlet", targetId: actx.characterId, emotion: "angry", intensity: 3, reason: `和人吵了一架，火气还没消`, durationTicks: 8 },
        ],
        duration: 2,
        observableState: `和${nearbyDisplayName(ctx, target)}之间的气氛一下绷紧了。`,
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
        observableState: "站在路边小声向陌生人开口，神情有些难堪。",
        _begAmount: amount,
      } as ActionResult & { _begAmount: number };
    },
  };
}

/** sell：把随身物品卖给杂货店（半价回收，念想不卖） */
function buildSellTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "sell",
      description: "把你身上带的东西卖给杂货店店主换钱（旧货半价回收）。带了什么看随身物品。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么要卖它" },
          item: { type: "string", description: "卖什么（你随身物品里的）" },
        },
        required: ["item"],
      },
    },
    handler: (args, _actx): ActionResult => {
      const rawItem = args.item as string;
      const def = resolveItem(rawItem);
      const itemId = def?.id ?? rawItem;
      if (!hasItem(ctx.state.inventory ?? [], itemId)) {
        return { description: `你身上没有${def?.name ?? rawItem}`, effects: [], success: false };
      }
      if (!def || def.type === "keepsake" || (def.value ?? 0) <= 0) {
        return { description: `店主拿起${def?.name ?? rawItem}翻看了两下，摆摆手：这个不值钱，收不了`, effects: [], success: false };
      }
      const price = Math.max(1, Math.floor((def.value ?? 0) / 2));
      return {
        description: `把${def.name}卖给了杂货店店主，得了 ${price} 金币`,
        effects: [],
        duration: 1,
        observableState: `在杂货店柜台前和店主交割一件旧货。`,
        _sellItem: { defId: itemId, price },
      } as ActionResult & { _sellItem: { defId: string; price: number } };
    },
  };
}

/** take_medicine：吃药治着凉（清病痛 moodlet 在 executeAction 落地） */
function buildTakeMedicineTool(): ActionDefinition {
  return {
    tool: {
      name: "take_medicine",
      description: "把带着的感冒药就水吃了。着凉这种病拖着只会越来越虚，吃了药踏实。",
      parameters: {
        type: "object",
        properties: { thought: { type: "string", description: "你在想什么" } },
      },
    },
    handler: (_args, actx): ActionResult => ({
      description: "把感冒药就着水咽下去，靠了一会儿，身上那股发冷的劲儿慢慢退了",
      effects: [
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: 5 },
      ],
      duration: 2,
      observableState: "刚吃了药，脸色还有点白，但精神看着缓过来了些。",
      _takeMedicine: true,
    } as ActionResult & { _takeMedicine: boolean }),
  };
}

/** repay_debt：把欠在场债主的钱还上（转账/销账在 executeAction 结算） */
function buildRepayDebtTool(): ActionDefinition {
  return {
    tool: {
      name: "repay_debt",
      description: "把欠人家的钱当面还上。欠着的账压在心里，还了人情才续得上。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          target: { type: "string", description: "还给谁（你的债主，此刻在场）" },
        },
        required: ["target"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想把钱还给${target}，但对方不在这里`, effects: [], success: false };
      }
      return {
        // 金额/销账由 executeAction 按账本结算，描述会被改写
        description: `把欠${target}的钱还上`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: 8 },
        ],
        duration: 1,
        observableState: "把一小叠金币郑重地递到对方手里，像是了结一桩心事。",
        _repayDebt: { lenderId: target },
      } as ActionResult & { _repayDebt: { lenderId: string } };
    },
  };
}

/** borrow_money：向在场的人开口借钱。答不答应看交情和对方手头（executeAction 里结算） */
function buildBorrowMoneyTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "borrow_money",
      description: "拉下脸向在场的熟人开口借钱。对方答不答应要看交情和人家自己的手头；借了就是欠着，人情账比金币账重。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，开这个口有多难" },
          target: { type: "string", description: "向谁借（角色 ID，必须此刻在场）" },
          amount: { type: "number", description: "想借多少（10-30 金币）" },
        },
        required: ["target"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `想找${target}借钱，但对方不在这里`, effects: [], success: false };
      }
      const amount = Math.max(10, Math.min(30, Math.round((args.amount as number) || 20)));
      return {
        // 描述占位：借没借到由 executeAction 按交情和对方手头改写
        description: `向${target}开口借 ${amount} 金币`,
        effects: [],
        duration: 1,
        _borrowAsk: { targetId: target, amount },
      } as ActionResult & { _borrowAsk: { targetId: string; amount: number } };
    },
  };
}

/** 翻垃圾找吃的：饿比丢人更疼的时候，人真的会这么做 */
function buildScavengeTool(): ActionDefinition {
  return {
    tool: {
      name: "scavenge_trash",
      description: "翻翻店铺后巷的垃圾桶，找些别人扔掉但还能吃的东西。丢人，但饿比丢人更疼。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      const found = Math.random() < 0.7;
      if (!found) {
        return {
          description: "在后巷垃圾桶里翻了半天，只有烂菜叶和空罐头，什么能吃的都没找到",
          effects: [
            { type: "need_change", targetId: actx.characterId, field: "fun", delta: -8 },
            { type: "need_change", targetId: actx.characterId, field: "hygiene", delta: -12 },
          ],
          duration: 1,
          observableState: "在垃圾桶边上翻找，头埋得很低，不想被人认出来。",
        };
      }
      return {
        description: "在后巷垃圾桶里翻到了别人扔的半块面包，拍了拍灰就吃了",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "hunger", delta: 20 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -12 },
          { type: "need_change", targetId: actx.characterId, field: "hygiene", delta: -15 },
          { type: "moodlet", targetId: actx.characterId, emotion: "sad", intensity: 3, reason: "沦落到翻垃圾桶找吃的", durationTicks: 16 },
        ],
        duration: 1,
        observableState: "在垃圾桶边上翻找，头埋得很低，不想被人认出来。",
      };
    },
  };
}

/** 卖血：一次性来钱快，身体要虚好几天。冷却用"卖血后的虚弱"moodlet 判定（3 游戏天） */
function buildSellBloodTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "sell_blood",
      description: "去镇卫生所卖一次血，能拿一笔营养费。身体会虚上好几天，卫生所也不许连着卖。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      if (ctx.state.moodlets?.some((m) => m.reason.includes("卖血"))) {
        return { description: "想再去卖血，卫生所的人翻了翻记录直摆手：上次抽的还没缓过来，不能再抽", effects: [], success: false };
      }
      if ((ctx.state.needs.energy ?? 100) < 30) {
        return { description: "想去卖血换点钱，可这副气色卫生所根本不敢收", effects: [], success: false };
      }
      return {
        description: "去卫生所卖了一次血，攥着 30 金币营养费出来，腿有点软",
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -30 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -10 },
          { type: "moodlet", targetId: actx.characterId, emotion: "anxious", intensity: 3, reason: "卖血后的虚弱，缓上几天才行", durationTicks: 288 },
        ],
        duration: 2,
        observableState: "胳膊肘内侧贴着一小块棉球胶布，脸色发白。",
        _workerIncome: 30,
      } as ActionResult & { _workerIncome: number };
    },
  };
}

/** 陪酒：底线最靠外的一档——钱最多，尊严代价也最重，且会被镇上人看在眼里 */
function buildHostessTool(): ActionDefinition {
  return {
    tool: {
      name: "accompany_drinks",
      description: "在酒吧陪客人喝酒说笑赚陪酒钱。来钱快，但要陪笑脸受打量，镇上人看见了会传闲话——这条线一旦跨过去，有些东西就回不来了。",
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，是什么把你逼到这一步" },
        },
      },
    },
    handler: (_args, actx): ActionResult => {
      const amount = 30 + Math.floor(Math.random() * 16); // 30~45
      return {
        description: `在酒吧陪客人喝酒说笑到深夜，赚了 ${amount} 金币陪酒钱。笑得脸都僵了，酒气沾了一身`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "energy", delta: -15 },
          { type: "need_change", targetId: actx.characterId, field: "fun", delta: -20 },
          { type: "need_change", targetId: actx.characterId, field: "hygiene", delta: -10 },
          { type: "moodlet", targetId: actx.characterId, emotion: "sad", intensity: 4, reason: "为了钱陪陌生人喝酒赔笑，心里像堵了块东西", durationTicks: 32 },
        ],
        duration: 3,
        observableState: "坐在客人桌边陪酒赔笑，眼神却时不时飘向门口。",
        _workerIncome: amount,
      } as ActionResult & { _workerIncome: number };
    },
  };
}

function buildStealTool(ctx: ToolBuildContext): ActionDefinition {
  return {
    tool: {
      name: "steal",
      description: "偷东西。你饿到不行了。可能会被抓——被抓到的话，对方不会轻易忘记。",
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
      // 附近有人时偷的是具体的人（真实转移），没人时偷店里的东西
      const victims = actx.nearbyCharacters;
      const victimId = victims.length > 0 ? victims[Math.floor(Math.random() * victims.length)]! : undefined;
      const selfName = ctx.card.name;
      if (caught) {
        if (victimId) {
          const victimName = nearbyDisplayName(ctx, victimId);
          // 被抓是"发生了的事"不是约束失败：后果必须真实落地
          return {
            description: `伸手去摸${victimName}的钱袋，被当场抓住了！`,
            effects: [
              { type: "relationship_change", targetId: victimId, delta: -20 },
              { type: "inbox_message", targetId: victimId, fromName: selfName, message: `（你抓住了${selfName}正在偷你东西的手）` },
              { type: "moodlet", targetId: victimId, emotion: "angry", intensity: 5, reason: `抓到${selfName}偷自己的东西`, durationTicks: 24 },
              { type: "moodlet", targetId: actx.characterId, emotion: "embarrassed", intensity: 5, reason: "偷东西被当场抓住，没脸见人", durationTicks: 24 },
            ],
            duration: 1,
            observableState: "被人抓住手腕，脸涨得通红——刚才想偷东西被逮个正着。",
          };
        }
        const isShop = ctx.location.type === "commercial";
        return {
          description: isShop
            ? `想顺手拿点东西，被店里的人发现赶了出来——店主放话：这几天别再进这个门`
            : `想顺手拿点东西，被人发现赶了出来`,
          effects: [
            { type: "moodlet", targetId: actx.characterId, emotion: "embarrassed", intensity: 4, reason: "偷东西被发现赶出来", durationTicks: 16 },
          ],
          duration: 1,
          observableState: "灰头土脸地从店里出来，身后有人在骂。",
          // 偷店被抓的真实后果：这家店 3 天拒绝服务（agent-loop 落到 location.bans）
          ...(isShop ? { _shopBan: { locationId: ctx.location.id, durationTicks: 288 } } : {}),
        } as ActionResult & { _shopBan?: { locationId: string; durationTicks: number } };
      }
      return {
        description: victimId
          ? `趁人不注意，从${nearbyDisplayName(ctx, victimId)}那里摸走了 ${amount} 金币`
          : `悄悄拿走了 ${amount} 金币的东西`,
        effects: [],
        duration: 1,
        observableState: "动作有些心虚，像是刚做了不想让人知道的事。",
        _stolenAmount: amount,
        _stealVictimId: victimId,
      } as ActionResult & { _stolenAmount: number; _stealVictimId?: string };
    },
  };
}

// ── 地点工具（从 YAML 读取，自然语言描述） ──

/** 为地点工具生成自然语言描述（缓存纪律：只用地点级慢变量，不嵌在场者/数值状态） */
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

/**
 * prepare 工具：员工可以从自家店铺菜单制作任意物品（免费），物品进入背包。
 * 制作后可以 give 给别人，或自己 eat。
 */
function buildPrepareTool(shop: ShopItem[], ctx: ToolBuildContext): ActionDefinition {
  const itemList = shop.map(s => s.name).join("、");

  return {
    tool: {
      name: "prepare",
      description: `制作店里的东西补货架（你是这里的员工，不用花钱，老板按件给工钱）。可以做：${itemList}`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          item: { type: "string", description: `要做什么：${itemList}` },
        },
        required: ["item"],
      },
    },
    handler: (args, actx): ActionResult => {
      // 执行期校验（原为工具集合门槛）：体力太低做不动
      if ((ctx.state.needs.energy ?? 100) < 15) {
        return { description: "想做点东西，但累得连手都抬不起来了", effects: [], success: false };
      }
      const rawItem = args.item as string;
      const resolved = resolveItem(rawItem);
      const shopItem = shop.find(s => s.name === rawItem || s.id === rawItem || (resolved && s.id === resolved.id));
      if (!shopItem) {
        return { description: `不知道怎么做${rawItem}`, effects: [], success: false };
      }
      const effects: ActionResult["effects"] = [
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: -2 },
      ];
      // 劳动出技能：40-80 次真实劳动升一级，晋升系统从死路复活
      if (actx.workSkill) {
        effects.push({ type: "skill_up", targetId: actx.characterId, skill: actx.workSkill, delta: 0.05 });
      }
      // 计件工钱：只有货架真的能再摆（未满）才有收入——堆库存老板不付钱，防原地刷钱
      const shelfFull = (ctx.location.stock?.[shopItem.id] ?? 0) >= 8;
      return {
        description: shelfFull
          ? `做了一份${shopItem.name}，但货架已经堆满了，老板皱着眉没记这一件的工钱`
          : `做了一份${shopItem.name}，摆上了货架`,
        effects,
        duration: 1,
        observableState: `正在做一份${shopItem.name}，动作熟练得像条件反射。`,
        // 产出进店铺货架（早晨烤的面包别人真能买到），不再无中生有进自己口袋
        _stockItem: { defId: shopItem.id },
        ...(shelfFull ? {} : { _workerIncome: 3 }),
      } as ActionResult & { _stockItem: { defId: string }; _workerIncome?: number };
    },
  };
}

// ── 菜园工具（世界可改造：种下去的东西真实存在、跨日生长） ──

/** 蔬菜从种下到成熟：2 游戏天 */
export const CROP_MATURE_TICKS = 192;
/** 一次收获的蔬菜数 */
export const CROP_YIELD = 4;

export function gardenIsMature(garden: { plantedTick: number; matureTicks: number }, tick: number): boolean {
  return tick - garden.plantedTick >= garden.matureTicks;
}

function buildPlantCropTool(): ActionDefinition {
  return {
    tool: {
      name: "plant_crop",
      description: "在农田认领一小块地，把你带的蔬菜种子种下去。两天左右能收一茬，自己种的菜不花钱。",
      parameters: {
        type: "object",
        properties: { thought: { type: "string", description: "你在想什么" } },
      },
    },
    handler: (_args, _actx): ActionResult => ({
      description: "翻了翻土，把蔬菜种子种进了地里，浇了点水。过两天就能来收了",
      effects: [],
      duration: 2,
      observableState: "蹲在田垄边翻土下种，手上沾了泥。",
      _plantCrop: { cropId: "fresh_vegetables", matureTicks: CROP_MATURE_TICKS },
    } as ActionResult & { _plantCrop: { cropId: string; matureTicks: number } }),
  };
}

function buildTendCropTool(): ActionDefinition {
  return {
    tool: {
      name: "tend_crop",
      description: "照看你的菜地：拔草、浇水、松土。菜会长得快一点，看着自己种的东西一天天长也踏实。",
      parameters: {
        type: "object",
        properties: { thought: { type: "string", description: "你在想什么" } },
      },
    },
    handler: (_args, actx): ActionResult => ({
      description: "给菜地拔了草、浇了水，菜苗看着精神了些",
      effects: [
        { type: "need_change", targetId: actx.characterId, field: "fun", delta: 6 },
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: -4 },
      ],
      duration: 2,
      observableState: "蹲在自己那块菜地边上拔草浇水，弄得很仔细。",
      _tendCrop: true,
    } as ActionResult & { _tendCrop: boolean }),
  };
}

function buildHarvestCropTool(): ActionDefinition {
  return {
    tool: {
      name: "harvest_crop",
      description: "你菜地里的菜熟了，收下来。自己种的菜，能吃能送人也能拿去卖。",
      parameters: {
        type: "object",
        properties: { thought: { type: "string", description: "你在想什么" } },
      },
    },
    handler: (_args, actx): ActionResult => ({
      description: "把地里熟了的菜收了下来，装了满满一篮子",
      effects: [
        { type: "need_change", targetId: actx.characterId, field: "fun", delta: 10 },
        { type: "need_change", targetId: actx.characterId, field: "energy", delta: -5 },
      ],
      duration: 2,
      observableState: "抱着一篮子刚收的菜，脸上带着点收成的踏实劲儿。",
      _harvestCrop: true,
    } as ActionResult & { _harvestCrop: boolean }),
  };
}

function buildBuyTool(shop: ShopItem[], ctx: ToolBuildContext): ActionDefinition {
  // 季节市场价：应季便宜、反季贵。展示（环境快照）/扣款两处用同一到手价，保持一致
  const season = ctx.season ?? "spring";
  const priceOf = (s: ShopItem) => effectivePrice(s.price, s.id, season);

  // 缓存纪律：描述静态（商品名清单是地点级慢变量）；价格/库存/买不买得起在环境快照里，
  // 营业/钱够/库存改在执行期校验。
  const itemNames = shop.map(s => s.name).join("、");

  return {
    tool: {
      name: "buy",
      description: `买东西带走。这里平时卖：${itemNames}。现价、库存、你带的钱够不够，看下方环境快照。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么" },
          item: { type: "string", description: `要买的物品名` },
        },
        required: ["item"],
      },
    },
    handler: (args, actx): ActionResult => {
      const rawItem = (args.item as string | undefined)?.trim();
      if (!rawItem || rawItem === "undefined") {
        return { description: "想买东西但没想好买什么", effects: [], success: false };
      }
      // 执行期校验（原为工具集合门槛）：打烊的店买不了东西
      if (!isLocationOpen(ctx.location, ctx.hour)) {
        return { description: "想买点东西，但店这个点已经打烊了", effects: [], success: false };
      }
      // 偷店被抓的余波：拉黑期内店主拒绝服务
      const banUntil = ctx.location.bans?.[actx.characterId];
      if (banUntil !== undefined && actx.tick < banUntil) {
        return { description: "刚进门就被店主黑着脸拦下来请了出去——上次的事人家还记着", effects: [], success: false };
      }
      // 支持 ID 和中文名：LLM 可能传 "notebook" 或 "笔记本"
      const resolved = resolveItem(rawItem);
      const shopItem = shop.find(s => s.id === rawItem || s.name === rawItem || (resolved && s.id === resolved.id));
      if (!shopItem) {
        return { description: `这里没有卖${rawItem}`, effects: [], success: false };
      }
      const price = priceOf(shopItem);
      if (actx.gold < price) {
        return { description: `钱不够买${shopItem.name}`, effects: [], success: false };
      }
      // 执行时复检库存：并行决策下最后一件可能同 tick 刚被别人买走（ctx.location 是活引用）
      if (ctx.location.stock && ctx.location.stock[shopItem.id] !== undefined && ctx.location.stock[shopItem.id]! <= 0) {
        return { description: `想买${shopItem.name}，结果刚好卖完了`, effects: [], success: false };
      }
      return {
        description: `买了${shopItem.name}`,
        effects: [],
        observableState: `手里拿着刚买的${shopItem.name}，还没决定是自己留着还是带走。`,
        _buyItem: { defId: shopItem.id, price },
      } as ActionResult & { _buyItem: { defId: string; price: number } };
    },
  };
}

/**
 * eat 工具：整合背包食物 + 当前地点商店食物。
 * 背包里的直接吃（免费），商店的买了直接吃（花钱）。
 * 缓存纪律：恒定声明、描述静态；手边有什么吃的在执行期计算（清单见环境快照）。
 */
function buildEatTool(ctx: ToolBuildContext): ActionDefinition {
  // 执行期计算"手边能吃什么"：背包食物 + 营业中店铺里买得起且有货的吃食
  const edibleNow = () => {
    const bagFood = (ctx.state.inventory ?? []).filter(i => {
      const def = getItemDef(i.defId);
      return def && def.effects && (def.type === "consumable" || (def.type === "gift" && def.effects));
    });
    const locOpen = isLocationOpen(ctx.location, ctx.hour)
      && !((ctx.location.bans?.[ctx.state.id] ?? 0) > (ctx.tick ?? 0)); // 拉黑期内店里的东西吃不上
    const shopFood = !locOpen ? [] : (ctx.location.shop ?? []).filter(s => {
      const def = getItemDef(s.id);
      const hasStock = ctx.location.stock?.[s.id] === undefined || ctx.location.stock[s.id]! > 0;
      return def && def.effects && def.type === "consumable" && ctx.gold >= s.price && hasStock;
    });
    return { bagFood, shopFood };
  };

  return {
    tool: {
      name: "eat",
      description: `吃点东西——你身上带着的（免费）或这里店里卖的（花钱）。手边有什么可吃的看下方环境快照和随身物品。`,
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
      const { bagFood, shopFood } = edibleNow();
      let rawItem = (args.item as string | undefined)?.trim();
      // 没说吃什么就随手拿最顺手的：背包第一个食物 > 店里最便宜的。
      // 真人饿了不会因为"没想好吃什么"而吃不上饭——此前这里直接失败白烧一次重试。
      if (!rawItem || rawItem === "undefined") {
        const fallbackId = bagFood[0]?.defId ?? [...shopFood].sort((a, b) => a.price - b.price)[0]?.id;
        if (!fallbackId) {
          return { description: "想吃东西但手边什么吃的都没有", effects: [], success: false };
        }
        rawItem = fallbackId;
      }
      // 支持 ID 和中文名；解析不了的（"冰箱里的东西"、"速食咖喱包"——半日实测 11 次幻觉食物）
      // 降级：带着吃的就吃带着的（真人饿了不挑），什么都没有就明确指路，别让模型对着幻觉重试
      let def = resolveItem(rawItem);
      if (!def) {
        const fallback = bagFood[0] ? getItemDef(bagFood[0].defId) : undefined;
        if (fallback) {
          def = fallback;
        } else {
          return {
            description: `想吃${rawItem}，但手边根本没有这个——身上没带吃的，想吃东西得去有吃食的店里买，或者买食材回家做`,
            effects: [], success: false,
          };
        }
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
          observableState: `正慢慢吃着${def.name}${ctx.nearbyCharacters.length > 0 ? "，像是顺便留意着周围的人" : ""}。`,
          _useItem: itemId,
        } as ActionResult & { _useItem: string };
      } else if (shopItem) {
        // 执行期校验（原为工具集合门槛，为保前缀稳定挪到这里）：营业、钱够、库存
        if (!isLocationOpen(ctx.location, ctx.hour)) {
          return { description: `想买${def.name}吃，但店这个点已经打烊了`, effects: [], success: false };
        }
        if (actx.gold < shopItem.price) {
          return { description: `想买${def.name}吃，但身上的钱不够`, effects: [], success: false };
        }
        // 执行时复检库存（并行决策下最后一份可能同 tick 刚被买走）
        if (ctx.location.stock && ctx.location.stock[itemId] !== undefined && ctx.location.stock[itemId]! <= 0) {
          return { description: `想买${def.name}吃，结果刚好卖完了`, effects: [], success: false };
        }
        return {
          description: `买了${def.name}吃`,
          effects,
          duration: 2,
          observableState: `手边是刚买的${def.name}，正坐下来慢慢吃。`,
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
        observableState: "在厨房里忙着做饭，锅里咕嘟咕嘟冒着热气。",
        _useItem: "ingredients",
      } as ActionResult & { _useItem: string };
    },
  };
}

function buildGiveTool(ctx: ToolBuildContext): ActionDefinition {
  // 缓存纪律：描述静态。带了什么看 user prompt 的随身物品段，在场者看"你现在看见了谁"。
  return {
    tool: {
      name: "give",
      description: `把你身上带的东西或金币给在场的人（给钱填 gold，给东西填 item，至少填一样）。说"给你"不算给，用这个工具才是真的给。`,
      parameters: {
        type: "object",
        properties: {
          thought: { type: "string", description: "你在想什么，为什么想给" },
          target: { type: "string", description: `给谁（角色 ID，必须此刻在场）` },
          item: { type: "string", description: "给什么东西（你随身物品里的，可不填）" },
          gold: { type: "number", description: "给多少金币（可不填）" },
        },
        required: ["target"],
      },
    },
    handler: (args, actx): ActionResult => {
      const target = args.target as string;
      if (!actx.nearbyCharacters.includes(target)) {
        return { description: `${target}不在这里`, effects: [], success: false };
      }
      // 给钱：真金白银的转移（还小钱/凑份子/接济，机制上第一次有路可走）
      const goldAmount = Math.round((args.gold as number) || 0);
      if (goldAmount > 0 && !args.item) {
        if (actx.gold < goldAmount) {
          return { description: `想给${target}${goldAmount}金币，但你身上只有${actx.gold}`, effects: [], success: false };
        }
        return {
          description: `把 ${goldAmount} 金币给了${target}`,
          effects: [
            { type: "need_change", targetId: actx.characterId, field: "social", delta: 3 },
          ],
          duration: 1,
          observableState: `正把几枚金币递到${nearbyDisplayName(ctx, target)}手里。`,
          _giveGold: { targetId: target, amount: goldAmount },
        } as ActionResult & { _giveGold: { targetId: string; amount: number } };
      }
      const rawItem = args.item as string;
      if (!rawItem) {
        return { description: "想给点什么，但没说清给什么", effects: [], success: false };
      }
      const def = resolveItem(rawItem);
      const itemId = def?.id ?? rawItem;
      if (!hasItem(ctx.state.inventory ?? [], itemId)) {
        return { description: `你没有${def?.name ?? rawItem}`, effects: [], success: false };
      }
      return {
        description: `把${def?.name ?? rawItem}给了${target}`,
        effects: [
          { type: "need_change", targetId: actx.characterId, field: "social", delta: 5 },
          { type: "need_change", targetId: target, field: "social", delta: 10 },
        ],
        observableState: `正把${def?.name ?? rawItem}递给${nearbyDisplayName(ctx, target)}。`,
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
      observableState: ({
        journal: `低头在${itemName}上写着什么，神情很专注。`,
        practice_music: "抱着吉他慢慢试音，像在确认每个音准。",
        fish: "握着鱼竿盯着水面，耐心地等着动静。",
        draw: "低头画着什么，时不时退远一点看一眼。",
        photograph: "举着相机到处找角度，像想把这一刻留住。",
      } as Record<string, string>)[toolId],
    }),
  };
}

// ── 地点工具（从 YAML 读取，自然语言描述） ──

/** 需求条件未满足时的自然语言反馈（按需求字段给人话，交给 tool-feedback 纠偏） */
function conditionNotMetMessage(field: string, ltName: string): string {
  switch (field) {
    case "energy": return ltName === "sleep" ? "你现在精神还不错，躺下也睡不着" : "你现在不怎么累，没必要休息";
    case "hunger": return "你现在不饿，吃不下";
    case "hygiene": return "你现在还挺干净，不用洗";
    case "bladder": return "你现在还不急";
    case "fun": return "你现在没这个心情";
    case "social": return "你现在没这个心情";
    default: return "你现在没这个需要";
  }
}

function buildLocationTool(
  lt: LocationTool,
  ctx: ToolBuildContext,
  opts?: { isWorkerTool?: boolean },
): ActionDefinition | null {
  // 缓存纪律：集合级只保留静态条件（isWorkplace 随角色×地点不变）。
  // 需求阈值/金币/营业这类每 tick 抖动的门槛全部挪到执行期校验。
  if (lt.condition === "isWorkplace") {
    const workplace = ctx.state.life?.workplace ?? ctx.card.life?.workplace;
    if (workplace && ctx.location.id !== workplace) {
      return null;
    }
  }

  // 构建自然语言描述
  const desc = describeLocationTool(lt, ctx);

  const isWorkerHere = (ctx.state.life?.workplace ?? ctx.card.life?.workplace) === ctx.location.id;

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
      // ── 执行期校验（原为工具集合门槛，为保前缀稳定挪到这里） ──
      // 顾客侧工具在打烊的商铺不可用（员工不受限：可以进来备货/收拾）
      if (!opts?.isWorkerTool && ctx.location.type === "commercial" && !isWorkerHere && !isLocationOpen(ctx.location, ctx.hour)) {
        return { description: "这里这个点已经打烊了，做不成", effects: [], success: false };
      }
      // 员工工具：体力太低做不动
      if (opts?.isWorkerTool && (ctx.state.needs.energy ?? 100) < 15) {
        return { description: "想干点活，但累得连手都抬不起来了", effects: [], success: false };
      }
      // 需求阈值条件（如 "energy < 40"）：不满足时给自然语言反馈；深夜总是可以睡觉
      if (lt.condition && lt.condition.includes("<")) {
        const match = lt.condition.match(/(\w+)\s*<\s*(\d+)/);
        if (match) {
          const field = match[1]!;
          const threshold = parseInt(match[2]!, 10);
          const isNight = ctx.hour !== undefined && (ctx.hour >= 22 || ctx.hour < 5);
          const isSleepTool = lt.name === "sleep";
          if (!(isSleepTool && isNight) && ctx.state.needs[field] !== undefined && ctx.state.needs[field] >= threshold) {
            return { description: conditionNotMetMessage(field, lt.name), effects: [], success: false };
          }
        }
      }
      // 金币不够
      if (lt.cost && actx.gold < lt.cost) {
        return { description: "摸了摸口袋，身上带的钱不够", effects: [], success: false };
      }

      const effects: ActionResult["effects"] = Object.entries(lt.effects).map(([field, delta]) => ({
        type: "need_change" as const,
        targetId: actx.characterId,
        field,
        delta,
      }));
      // 员工工具（带 income 的）附带技能成长——工作不再是无成长的哑剧
      if (lt.income && actx.workSkill) {
        effects.push({ type: "skill_up", targetId: actx.characterId, skill: actx.workSkill, delta: 0.05 });
      }
      const result: ActionResult & { _cost?: number; _workerIncome?: number } = {
        description: lt.description.replace(/（.*?）/, ""),
        effects,
        duration: lt.duration ?? 1,
        observableState: describeLocationObservableState(lt, ctx),
      };
      if (lt.cost) result._cost = lt.cost;
      if (lt.income) result._workerIncome = lt.income;
      return result;
    },
  };
}

// ── 环境快照（user prompt 末尾的动态可供性信息） ──

/**
 * 生成"此刻的环境"快照文本，注入 user prompt 末尾的易变区。
 *
 * 这是缓存手术的另一半：工具描述里挪出去的动态信息（各地点谁在/是否营业、
 * 店里现价/库存/买不买得起）全部在这里补回给模型。工具表保持字节稳定，
 * 时效信息作为消息内容随每 tick 更新——对应 Claude Code 的 system-reminder 模式。
 */
export function buildEnvironmentSnapshot(ctx: ToolBuildContext): string {
  const lines: string[] = [];

  // 镇上人物分布 + 营业状态（原 go_to 工具描述里的动态部分）
  const myHome = ctx.card.home;
  const otherLocations = ctx.allLocations
    .filter((l) => l.id !== ctx.location.id)
    .filter((l) => l.type !== "residential" || l.id === myHome);
  if (otherLocations.length > 0) {
    const locBits = otherLocations.map((l) => {
      const label = l.id === myHome ? "家" : l.name;
      const notes: string[] = [];
      const people = l.presentCharacters
        .filter((cid) => cid !== ctx.card.id)
        .map((cid) => ctx.characterNames?.get(cid) ?? cid)
        .filter((name) => name.length > 0);
      if (people.length > 0) notes.push(`${people.join("、")}在那里`);
      if (l.type === "commercial" && !isLocationOpen(l, ctx.hour)) notes.push("这个点已打烊");
      return notes.length > 0 ? `${label}（${notes.join("；")}）` : label;
    });
    lines.push(`镇上其他地方：${locBits.join("、")}。`);
  }

  // 本地点商店现况（原 buy/eat 工具描述里的动态部分）
  if (ctx.location.shop && ctx.location.shop.length > 0) {
    if (!isLocationOpen(ctx.location, ctx.hour)) {
      lines.push("这里的店这个点已经打烊了，买不了东西。");
    } else {
      const season = ctx.season ?? "spring";
      const itemBits = ctx.location.shop.map((s) => {
        const stock = ctx.location.stock?.[s.id];
        if (stock !== undefined && stock <= 0) return `${s.name}（卖完了）`;
        const p = effectivePrice(s.price, s.id, season);
        const tag = p < s.price ? "，应季实惠" : p > s.price ? "，反季偏贵" : "";
        const afford = ctx.gold < p ? "，你带的钱不够" : "";
        return `${s.name}（${p}金币${tag}${afford}）`;
      });
      lines.push(`店里现在卖：${itemBits.join("、")}。`);
    }
  }

  // 欠账（账压在心上：欠了谁、欠多少，见了面才好还）
  if (ctx.state.debts && ctx.state.debts.length > 0) {
    const bits = ctx.state.debts.map((d) => {
      const name = ctx.characterNames?.get(d.lenderId) ?? d.lenderId;
      return `${name}的${d.amount}金币`;
    });
    lines.push(`你还欠着${bits.join("、")}没还——这账一直压在心上。`);
  }

  // 菜地状态（世界可改造的部分要被主人惦记着）
  if (ctx.state.garden && ctx.tick !== undefined) {
    const g = ctx.state.garden;
    if (gardenIsMature(g, ctx.tick)) {
      lines.push("你在农田种的菜已经熟了，该去收了——再放下去要老在地里。");
    } else {
      const remainHours = Math.ceil((g.matureTicks - (ctx.tick - g.plantedTick)) / 4);
      lines.push(`你在农田种着一块菜地，大约还要${remainHours}小时成熟（去照看照看能熟得快点）。`);
    }
  }

  if (lines.length === 0) return "";
  return lines.join("\n");
}
