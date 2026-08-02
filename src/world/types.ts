/**
 * World State — 世界状态类型定义
 */

export interface LocationAtmosphere {
  morning?: string;
  afternoon?: string;
  evening?: string;
  night?: string;
  rainy?: string;
}

/** 地点提供的工具（从 YAML 加载） */
export interface LocationTool {
  name: string;
  description: string;
  effects: Record<string, number>;
  cost?: number;
  duration?: number;
  /** 条件：如 "energy < 80", "hygiene < 80", "isWorkplace" */
  condition?: string;
  /** 员工工具收入（每次执行获得的金币） */
  income?: number;
}

/** 职业阶梯等级 */
export interface CareerLevel {
  level: number;
  title: string;
  income: number;
  required_skill: Record<string, number>;
}

export interface Location {
  id: string;
  name: string;
  type: "residential" | "commercial" | "public" | "nature" | "special";
  /** 一句话摘要（用于 go_to 描述） */
  summary?: string;
  /** 开放时间（小时），null = 24 小时开放 */
  openHours?: { open: number; close: number } | null;
  /** 店铺库存（劳动产出闭环）：undefined=不追踪（无限），有员工的店每日重置+prepare 增补，卖一件少一件 */
  stock?: Record<string, number>;
  /** 店铺拉黑名单（偷店被抓的真实后果）：characterId → 解禁 tick，期间 buy/eat 被拒 */
  bans?: Record<string, number>;
  /** 当前在此地点的角色 ID */
  presentCharacters: string[];
  /** 感官描述（按时段/天气） */
  atmosphere?: LocationAtmosphere;
  /** 地点提供的工具 */
  tools?: LocationTool[];
  /** 职业阶梯（从 YAML 加载） */
  careerTrack?: CareerLevel[];
  /** 商店物品（从 YAML 加载） */
  shop?: import("./item-types.js").ShopItem[];
  /** 员工专属工具（从 YAML 加载） */
  workerTools?: LocationTool[];
}

/** 临时情绪效果（Moodlet） */
export interface Moodlet {
  id: string;
  emotion: "happy" | "sad" | "angry" | "embarrassed" | "anxious" | "confident" | "lonely" | "grateful";
  intensity: number;        // 1-5
  reason: string;           // "和爱音聊得很开心"
  expiresAtTick: number;
  source: "social" | "work" | "need" | "event" | "memory";
}

export type Weather = "sunny" | "cloudy" | "rainy" | "stormy" | "snowy";
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface WorldState {
  tick: number;
  weather: Weather;
  locations: Map<string, Location>;
}

/**
 * CharacterNeeds — 数据驱动的需求系统。
 * 键名对应 NeedDefinition.id（hunger/energy/social/hygiene/fun/bladder）。
 * 值域 0-100，低 = 该需求未被满足。
 *
 * 不再是固定的 interface——维度由 need-definitions.ts 配置决定。
 */
export type CharacterNeeds = Record<string, number>;

export interface InboxMessage {
  fromId: string;
  fromName: string;
  content: string;
  tick: number;
}

export interface CharacterIntent {
  kind: "reply" | "follow_up" | "recover" | "plan";
  summary: string;
  source: "message" | "action" | "movement";
  targetId?: string;
  createdTick: number;
  expiresAt: number;
}

/** 一笔欠账：欠谁、欠多少、什么时候借的（同一债主多次借款合并累加） */
export interface Debt {
  lenderId: string;
  amount: number;
  borrowedTick: number;
}

/** 菜园地块：种的什么、什么时候种的、还要长多久（tend 可以少量提前） */
export interface GardenPlot {
  /** 收获物的 item defId */
  cropId: string;
  plantedTick: number;
  /** 成熟所需 tick（种下时确定，照看可减少） */
  matureTicks: number;
}

export interface CharacterObservableState {
  actionName: string;
  summary: string;
  source: "action";
  targetId?: string;
  createdTick: number;
  expiresAt: number;
}

/**
 * 约定系统：两个角色说定的"什么时候在哪见面"。
 * 约定是世界状态不是对话内容——说定了就记录，时间到了就结算，谁没来世界都知道。
 * 没有接受/拒绝状态机：不想去可以不去，爽约本身就是活人行为。
 */
export interface Appointment {
  id: string;
  proposerId: string;
  targetId: string;
  /** 约定地点（限公共地点） */
  locationId: string;
  /** 约定时间 */
  atTick: number;
  /** 约好做什么（可选） */
  activity?: string;
  status: "pending" | "kept" | "missed";
  /**
   * 单方爽约时的缺席者 id。双方都没到（双爽约）或角色缺失时不填——
   * 压力图谱的爽约计数只认有 missedBy 的记录（派生查询，不加新计数器）。
   */
  missedBy?: string;
  createdTick: number;
}

/** D3: director 通过 seed_topic 注入的"想聊的话题" */
export interface WantToDiscuss {
  topic: string;
  urgency: "low" | "med" | "high";
  /** 只有和这个角色聊天时才提起（不填 = 和任何人都会提） */
  targetChar?: string;
  createdTick: number;
  expiresAt: number;
}

export interface CharacterState {
  id: string;
  name: string;
  /** 性别（从角色卡复制过来，便于场景描述时其他角色感知） */
  gender?: string;
  locationId: string;
  needs: CharacterNeeds;
  gold: number;
  /** 可变的生活状态（职业、技能、目标等） */
  life?: import("../character/types.js").LifeState;
  /** 临时情绪效果列表 */
  moodlets: Moodlet[];
  /** 当前正在执行的行为（多 tick 行为） */
  currentAction?: { name: string; remainingTicks: number };
  /** 当前还挂在心上的短期意图/未完事务，会自然过期 */
  currentIntent?: CharacterIntent;
  /**
   * 今天的打算（晨间计划）：每天早上基于昨日反思/今日约定/天气生成的 1-3 件想做的事。
   * 不是任务清单——是"心里有数"，行为从纯需求反应变成有主线的生活。跨天自动失效。
   */
  todayPlan?: { day: number; items: string[] };
  /**
   * 昨晚反思的完整结果。晨间打算直接读这里，
   * 不再靠 getRecentThoughts 的字符串前缀匹配碰运气（记忆被挤出就断链）。
   */
  lastReflection?: { day: number; insights: string[]; mood: string; wish?: string; concern?: string };
  /**
   * 菜园：在农田认领的一小块地。世界可改造——种下去的东西真实存在、跨日生长、
   * 收获物可吃可送可卖。随档持久化（garden_json）。
   */
  garden?: GardenPlot;
  /**
   * 欠账（我欠别人的）。借钱不是一句话——是要还的世界状态：见到债主且钱够时
   * repay_debt 浮现；拖着不还债主会催、会伤交情。随档持久化（debts_json）。
   */
  debts?: Debt[];
  /** 当前留在外界可被旁人观察到的生活痕迹 */
  observableState?: CharacterObservableState;
  /** D3: director 注入的"想聊的话题"，角色 talk 时 prompt 会引导围绕这些话题展开 */
  wantToDiscuss?: WantToDiscuss[];
  /** 消息信箱：其他角色发来的消息 */
  inbox: InboxMessage[];
  /** 随身物品 */
  inventory: import("./item-types.js").ItemInstance[];
  /** 最近行为记录（用于行为链追踪） */
  recentActions: { actionId: string; tick: number }[];
}
