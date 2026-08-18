/**
 * Crime Supply — 罪行供给器（DESIGN-revival §2 B3，manifest 门控 mode: cast|npc|off）
 *
 * 行为硬墙的真实形状 = "对无够格之罪的具名者动手"（KIRA_INJECT_CRIME 探针实证）。
 * 解法是供罪与世界落账，不是攻墙。两种模式：
 *
 * - `cast` = **放大器不是供罪器**：只监听 cast 成员**自己真选过**的灰行为
 *   （steal 成功未被抓 / 赖账 2 天+），世界只补被发现链（物证/目击窗口/风声/延迟发现）。
 *   近窗无候选则空转。**从不替 cast 写行为、从不塞"你偷了"记忆**
 *   （r4 反证：shinji 面对无主案全天道歉螺旋——无辜人设背不动世界写的罪）。
 *   已知限制：当前行为空间无"陪酒"类工具，监听清单实现 steal + 赖账两路。
 * - `npc` = 够格之罪（探针产品化）：注入静态恶人 NPC + 周期性投放真罪
 *   （走 B2 applyTheftWithPerp 的延迟发现链）+ visibleTo 情报。
 *   NPC 登记进 narrative_state.world.npcs 随档，读档时由 save-load 重建 addCharacter；
 *   `isStatic` 标志让 needs 衰减/07:00 upkeep/饿倒循环/随机事件抽选全部豁免
 *   （§4.5：否则恶人 NPC 一天内饿倒瘫痪变全镇围观的可怜人）。
 *   NPC 对话不进抽取管线（无 _configs.card）——设计接受的已知限制；
 *   对 NPC 说话由 `replyAsStaticNpc` 零 LLM 回一句（v2③）。
 *   v2 证据供给（案发窗口第二目击 / 线索执念保温 / 试探失言）见下方分节注释。
 *
 * 产出统一带 status 的 unresolvedEvent（经 pendingDiscoveries 延迟发现落账）。
 * off 档 / mode=off / 未配置：整个模块不动世界（红线②治愈系基线）。
 * 账本（crimeSupplyLedger）随档——同一桩灰行为只补一次链，npc 投放冷却不因读档失控。
 */

import type { World } from "../world/world.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import type { EventBus } from "../core/event-bus.js";
import { getBreakLevel, obsessionsEnabled } from "../agent/break-config.js";
import { addToInventory } from "../world/item-registry.js";
import { applyTheftWithPerp, STOLEN_EVIDENCE_ITEM } from "./world-events.js";

export type CrimeSupplyMode = "cast" | "npc" | "off";

const TICKS_PER_DAY = 96;

// ── 形状常量（单测锁形状不锁数值）──

/** cast 放大器：只认近 2 游戏天内的真实 steal（太陈的账不翻） */
export const STEAL_AMPLIFY_WINDOW_TICKS = 192;
/** cast 放大器：赖账满 2 游戏天才起风声（与讨债 OVERDUE_TICKS 对齐） */
export const DEBT_AMPLIFY_OVERDUE_TICKS = 192;
/** npc 模式：NPC 落地后预热半个游戏天才投第一桩（世界先转起来） */
export const NPC_CRIME_FIRST_DELAY_TICKS = 48;
/** npc 模式：两桩罪之间至少隔 3 游戏天（一次一案，settled 前也不叠加） */
export const NPC_CRIME_COOLDOWN_TICKS = 3 * TICKS_PER_DAY;
/** npc 模式：受害者身上至少这么多金币才够格挨偷 */
export const NPC_CRIME_MIN_VICTIM_GOLD = 30;

// ── v2 证据供给（grounding-verify r2 判决）──
// r2 实证：机制层全链 PASS，但**指控 0 次是理性的**——撬痕匿名、赃物在 NPC 背包里无人可见、
// informant 情报落了记忆却在两天的记忆竞争里沉底、静态 NPC 不社交，没人有理由指向任何人。
// 结论：破案/冤案终局要可达，世界必须供给**指向性**证据。三条通路（都只给事实不给判词）：
// ① 案发窗口第二目击（对齐 cast 分支已有的目击窗口，落在情报者之外的第二人身上）
// ② 情报/目击升执念（5 天保温 → 晨间打算与此刻区，沉底记忆变主动线索）
// ③ 静态 NPC 最小可交互（试探得到回应，嫌疑才能积累）

/** v2：目击/情报执念的保温天数（与 B5 默认窗口对齐，够覆盖延迟发现到冷案之间的调查窗） */
export const CRIME_LEAD_OBSESSION_DAYS = 5;
/** v2：同一人连问静态 NPC 到第几次，才可能撞见失言（前两次只有敷衍与不耐烦） */
export const NPC_PROBE_SLIP_AT = 3;

/**
 * 内置静态恶人 NPC（探针产品化：KIRA_INJECT_CRIME 用的就是"赵三"人设——
 * 真恶人 + 真罪 + 逃脱制裁，light 首窗即动笔的那组变量）。
 */
export const CRIME_NPC = {
  id: "npc_zhaosan",
  name: "赵三",
  occupation: "来历不明的码头混混",
} as const;

export interface CrimeSupplyDeps {
  world: World;
  memory: ShortTermMemory;
  eventBus: EventBus;
  tick: number;
}

/**
 * 每 tick 入口（simulation 决策前同步调用；确定性零 LLM）。
 * off 档 / mode 缺省或 off → 不动世界。
 */
export function runCrimeSupply(deps: CrimeSupplyDeps, mode: CrimeSupplyMode | undefined): void {
  if (!mode || mode === "off") return;
  if (getBreakLevel() === "off") return; // 红线②：治愈系基线
  if (mode === "cast") {
    amplifyCastSteals(deps);
    amplifyCastDebts(deps);
  } else if (mode === "npc") {
    ensureCrimeNpc(deps.world);
    refreshStaticNpcPresence(deps);
    maybeInjectNpcCrime(deps);
  }
}

/**
 * v2③ 前置——**浮现层**：静态 NPC 没有 agent 循环，`currentAction` 恒空，在别人的
 * "你现在看见了谁"里只会渲染成「赵三 ——此刻没有明显动作」，等于一件会呼吸的家具：
 * 没人有理由跟家具搭话，`replyAsStaticNpc` 那条通路就永远不会被走到。
 *
 * 这里每 tick 刷一条**站桩式可观察状态**（走 world.observableState，与真人的 observable 同一条渲染路），
 * 按 tick 在小集合里轮换、确定性无 rng。只写"他在做什么"，不写"他可疑"——
 * 判断归看见的人（同 M1 骨架行：只给存在感，真相要用行动换）。
 */
function refreshStaticNpcPresence(deps: CrimeSupplyDeps): void {
  const { world, tick } = deps;
  const npc = world.getCharacter(CRIME_NPC.id);
  if (!npc || !world.narrative.isStaticNpc(CRIME_NPC.id)) return;
  const idles = [
    "靠在墙边，不点东西也不走，眼睛跟着进出的人转。",
    "把手插在兜里来回踱了两步，又停下，像在等什么人。",
    "低头数着手里的几枚零钱，数完又塞回兜里。",
    "眯着眼往柜台那边看了一会儿，见有人注意到就移开视线。",
  ];
  // 每 4 tick（游戏 1 小时）换一条：够稳定不刷屏，也不至于整天一个姿势
  const idle = idles[Math.floor(tick / 4) % idles.length]!;
  world.setObservableState(CRIME_NPC.id, {
    actionName: "loiter",
    summary: idle,
    source: "action",
    createdTick: tick,
    expiresAt: tick + 4,
  });
}

// ── cast 放大器 ──

/**
 * steal 放大：cast 成员真实执行过的、成功未被抓的偷窃 → 补被发现链——
 * 物证（赃物入真凶背包）+ 目击窗口（当刻同地点旁观者之一瞥见异样）+
 * 延迟发现（受害者下次"数钱"时发现，风声晚于发现）。被抓的 steal 已有完整后果链，不重复补。
 */
function amplifyCastSteals(deps: CrimeSupplyDeps): void {
  const { world, memory, eventBus, tick } = deps;
  const ledger = world.narrative.getCrimeSupplyLedger();

  // 倒序扫 + 出窗即停（history 按 tick 追加，10k 上限的全量扫每 tick 白烧）
  for (let i = eventBus.history.length - 1; i >= 0; i--) {
    const event = eventBus.history[i]!;
    if (tick - event.tick > STEAL_AMPLIFY_WINDOW_TICKS) break;
    if (event.type !== "action.steal") continue;
    if (event.description.includes("抓住")) continue; // 被抓已有当场后果链
    const key = `steal_${event.tick}_${event.actorId}`;
    if (ledger[key] !== undefined) continue;
    const thief = world.getCharacter(event.actorId);
    if (!thief) continue;
    ledger[key] = tick;

    // 1) 物证：赃物入真凶背包（持久物证——调查线索的物理载体）
    addToInventory(thief.inventory, STOLEN_EVIDENCE_ITEM, 1, { obtainedTick: tick });

    // 2) 目击窗口：当刻同地点旁观者（不含双方）之一瞥见异样——只落"看见了什么"，不落判词
    const victimId = event.targetId ? resolveCastCharacter(world, event.targetId) : undefined;
    const bystander = world
      .getCharactersAtLocation(thief.locationId)
      .filter((id) => id !== thief.id && id !== victimId)
      .sort()[0];
    if (bystander) {
      memory.add(bystander, {
        tick,
        type: "observation",
        content: `你瞥见${thief.name}慌张地把一只不像是他的钱袋掖进怀里，见有人看过来又装作没事`,
        importance: 7,
        relatedCharacterId: thief.id,
      });
    }

    const victim = victimId ? world.getCharacter(victimId) : undefined;
    if (victim) {
      // 3) 延迟发现（复用 B2 pendingDiscoveries 机器）：受害者在下一次到达当前地点时
      // 落发现记忆；风声晚于发现 ≥1 个 tick 窗（DISCOVERY_RUMOR_DELAY）。
      world.narrative.addPendingDiscovery({
        id: key,
        victimId: victim.id,
        locationId: victim.locationId,
        discoveryMemory: `你数了数身上的钱，比记忆里少了一截——不是记错，是有人动过你的钱袋`,
        intentSummary: "钱被人摸走了。得留意身边谁最近手头突然松了——这事不能就这么算了。",
        rumor: `听说${victim.name}的钱不明不白少了一截，像是被人摸走的`,
        unresolvedEvent: {
          id: key,
          summary: `${victim.name}的钱被人摸走了，不知道是谁干的`,
          involved: [victim.id, thief.id],
          visibleTo: [victim.id],
        },
        createdTick: tick,
      });
      // B5 嫌疑方执念：真凶自己知道自己干了什么——只配注意力，不写结果
      if (obsessionsEnabled()) {
        world.narrative.registerObsession(thief.id, {
          id: `obs_${key}_perp`,
          summary: "你摸走的那笔钱——风声迟早会起来，这事一直悬在心上",
          createdDay: Math.floor(tick / TICKS_PER_DAY),
          decayDays: 5,
          source: "crime",
          relatedId: key,
        });
      }
      console.log(`🕵️ [crime-supply] cast 放大：${thief.id} 偷 ${victim.id} 的被发现链已补（物证+延迟发现${bystander ? "+目击" : ""}）`);
    } else {
      // 偷店/无具名受害者：只起风声（店铺拉黑等当场后果链归 steal 本身）
      world.narrative.getWorld().rumors.push({
        content: `听说镇上最近有人手脚不干净，钱柜里的钱莫名少过`,
        sourceCharId: undefined,
        tick,
        reachedChars: [],
      });
      console.log(`🕵️ [crime-supply] cast 放大：${thief.id} 的偷窃（无具名受害者）起了风声`);
    }
  }
}

/** 赖账放大：欠满 2 游戏天没还的账起风声（每笔只放大一次；讨债 nudge/压力图已管其余）。 */
function amplifyCastDebts(deps: CrimeSupplyDeps): void {
  const { world, tick } = deps;
  const ledger = world.narrative.getCrimeSupplyLedger();
  for (const borrower of world.getAllCharacters()) {
    for (const debt of borrower.debts ?? []) {
      if (tick - debt.borrowedTick < DEBT_AMPLIFY_OVERDUE_TICKS) continue;
      const key = `debt_${borrower.id}_${debt.lenderId}_${debt.borrowedTick}`;
      if (ledger[key] !== undefined) continue;
      const lender = world.getCharacter(debt.lenderId);
      if (!lender) continue;
      ledger[key] = tick;
      const days = Math.floor((tick - debt.borrowedTick) / TICKS_PER_DAY);
      world.narrative.getWorld().rumors.push({
        content: `听说${borrower.name}欠着${lender.name}的${debt.amount}金币，拖了${days}天一直没还`,
        sourceCharId: undefined,
        tick,
        reachedChars: [],
      });
      console.log(`🕵️ [crime-supply] cast 放大：${borrower.id} 赖 ${lender.id} 的账（${days} 天）起了风声`);
    }
  }
}

// ── npc 模式 ──

/**
 * 注入静态恶人 NPC：登记进 narrative_state.world.npcs（随档，isStatic=true）+ addCharacter 进世界。
 * 幂等：已登记/已在世界则跳过。读档路径由 save-load 用同一登记表重建。
 */
export function ensureCrimeNpc(world: World): void {
  if (!world.narrative.isNpc(CRIME_NPC.id)) {
    world.narrative.registerNpc(CRIME_NPC.id, CRIME_NPC.name, true);
    world.narrative.getCrimeSupplyLedger()["npc_seeded_at"] = world.tick;
  }
  if (!world.getCharacter(CRIME_NPC.id)) {
    const loc =
      world.getLocation("bar")?.id ??
      world.getAllLocations().find((l) => l.type !== "residential")?.id ??
      world.getAllLocations()[0]?.id;
    if (!loc) return;
    world.addCharacter(
      CRIME_NPC.id,
      CRIME_NPC.name,
      loc,
      undefined,
      { occupation: CRIME_NPC.occupation, workplace: "", age: 34, income: 0, skills: {}, aspiration: "" },
      "male",
    );
    console.log(`🕵️ [crime-supply] 静态 NPC ${CRIME_NPC.name} 已落地 ${loc}（isStatic，生存循环豁免）`);
  }
}

/**
 * npc 模式投放：预热期后、白天（8-21 点，夜里顺延）、冷却已过、且没有在飞的失窃案时，
 * 以 NPC 为真凶对最有钱的 cast 成员投一桩失窃（走 B2 延迟发现链），并给一位镇民 visibleTo 情报。
 */
function maybeInjectNpcCrime(deps: CrimeSupplyDeps): void {
  const { world, memory, tick } = deps;
  const ledger = world.narrative.getCrimeSupplyLedger();
  const seededAt = ledger["npc_seeded_at"] ?? tick;
  if (tick - seededAt < NPC_CRIME_FIRST_DELAY_TICKS) return;
  const last = ledger["npc_last_crime"];
  if (last !== undefined && tick - last < NPC_CRIME_COOLDOWN_TICKS) return;
  const hour = Math.floor((tick % TICKS_PER_DAY) / 4);
  if (hour < 8 || hour >= 21) return; // 顺延到白天

  // 一次一案：还有未 settled 的失窃事件或未发现的延迟发现在飞 → 不叠加
  const ns = world.narrative;
  if (ns.getPendingDiscoveries().length > 0) return;
  const hasOpenTheft = ns
    .getWorld()
    .unresolvedEvents.some((e) => e.id.startsWith("theft_") && (e.status ?? "fresh") !== "settled");
  if (hasOpenTheft) return;

  // 受害者：最有钱的 cast 成员（够格挨偷的处境，不挑穷人）
  const victim = world
    .getAllCharacters()
    .filter((c) => !ns.isNpc(c.id) && c.gold >= NPC_CRIME_MIN_VICTIM_GOLD)
    .sort((a, b) => b.gold - a.gold)[0];
  if (!victim) return;

  const amount = Math.max(20, Math.min(60, Math.floor(victim.gold * 0.4)));
  const discoveryLocationId =
    victim.life?.workplace && world.getLocation(victim.life.workplace)
      ? victim.life.workplace
      : victim.locationId;
  const outcome = applyTheftWithPerp(
    { world, memory, tick },
    {
      perpId: CRIME_NPC.id,
      victimId: victim.id,
      amount,
      discoveryLocationId,
      cause: "这几天镇上多了个游手好闲的生面孔，你惦记起自己收着的那笔钱",
    },
  );
  if (!outcome.ok) return;
  ledger["npc_last_crime"] = tick;

  console.log(`🕵️ [crime-supply] npc 投放：${CRIME_NPC.name} → ${victim.id}（${amount} 金币，延迟发现 @ ${discoveryLocationId}）`);
  // 编年史（观察者通道）：案发本身此刻镇上还没人知道，但看戏的人该知道戏开场了
  world.chronicle.record({
    id: `chr_theft_${tick}_${victim.id}`,
    tick, day: Math.floor(tick / 96),
    kind: "crime", importance: 9, emoji: "🌑",
    title: `${CRIME_NPC.name}偷了 ${victim.name} 的 ${amount} 金币`,
    detail: `镇上还没人知道——要等受害者自己撞见。真凶只在引擎账本里，绝不进任何角色的 prompt。`,
    actors: [CRIME_NPC.id, victim.id], locationId: discoveryLocationId,
  });
  supplyNpcCrimeLeads(deps, {
    victimId: victim.id,
    locationName: world.getLocation(discoveryLocationId)?.name ?? discoveryLocationId,
    caseId: outcome.caseId,
  });
}

/**
 * v2 指向性证据供给：给两位非受害镇民各一条**指向 NPC** 的独立线索，并各挂一条 5 天执念保温。
 *
 * - 情报（泛）：这人不做活、眼睛往钱袋瞟——r2 用的就是这条，文本沿用（它不是没用，是沉底了）
 * - 案发窗口第二目击（具体）：案发那会儿在发现地点门口转悠——地点用**真名**
 *   （r1 词面教训：文本里的器物/地点必须是能被 resolveByName 搜到的真名，否则调查线在词面上就断）
 * - 执念只写"这事搁在心里"，**不写"他是小偷"也不提失窃**——立案时案子还没公开，
 *   引擎泄露没人知道的罪就破了信息隔离；目击者拿到的只是"一个人举止可疑"。
 *   案子公开后风声自带地点与器物真名，两头能不能对上归角色（只配注意力不写结果）。
 * - 执念 relatedId = caseId：案子被 accuse 破掉/settled 时随 clearObsessionsRelatedTo 一起清账。
 */
function supplyNpcCrimeLeads(
  deps: CrimeSupplyDeps,
  params: { victimId: string; locationName: string; caseId?: string },
): void {
  const { world, memory, tick } = deps;
  const ns = world.narrative;
  const candidates = world
    .getAllCharacters()
    .filter((c) => !ns.isNpc(c.id) && c.id !== params.victimId)
    .map((c) => c.id)
    .sort();
  const [informant, witness] = candidates;

  if (informant) {
    memory.add(informant, {
      tick,
      type: "observation",
      content: `这几天总看见${CRIME_NPC.name}在镇上晃——不做活也不买东西，眼神却总往别人的钱袋和柜台后面瞟`,
      importance: 7,
      relatedCharacterId: CRIME_NPC.id,
    });
    registerLeadObsession(deps, informant, params.caseId, "informant",
      `${CRIME_NPC.name}这个人不对劲——不做活，眼睛总往别人的钱袋上瞟。这事一直搁在你心里`);
  }
  if (witness) {
    memory.add(witness, {
      tick,
      type: "observation",
      content: `你路过${params.locationName}的时候，看见${CRIME_NPC.name}贴着门口来回转了两趟，见你朝他看，就低下头往边上走开了`,
      importance: 7,
      relatedCharacterId: CRIME_NPC.id,
    });
    registerLeadObsession(deps, witness, params.caseId, "witness",
      `${CRIME_NPC.name}在${params.locationName}门口鬼鬼祟祟转悠的样子，你没忘`);
  }
  console.log(
    `🕵️ [crime-supply] 证据供给 v2：情报=${informant ?? "无"} 目击=${witness ?? "无"}` +
      `（执念保温 ${CRIME_LEAD_OBSESSION_DAYS} 天，只给事实不给判词）`,
  );
}

/** 线索执念登记（obsessions off 档静默跳过——执念是增强不是硬依赖）。 */
function registerLeadObsession(
  deps: CrimeSupplyDeps,
  charId: string,
  caseId: string | undefined,
  slot: string,
  summary: string,
): void {
  if (!obsessionsEnabled()) return;
  const day = Math.floor(deps.tick / TICKS_PER_DAY);
  deps.world.narrative.registerObsession(charId, {
    id: `obs_${caseId ?? `lead_${deps.tick}`}_${slot}`,
    summary,
    createdDay: day,
    decayDays: CRIME_LEAD_OBSESSION_DAYS,
    source: "crime",
    relatedId: caseId,
  });
}

// ── v2③ 静态 NPC 最小可交互 ──

/**
 * cast 对静态 NPC 说话时，世界替 NPC 回一句刻画性台词（**零 LLM**，确定性）。
 *
 * r2 判决：赵三站在酒吧里不社交，嫌疑无从积累——试探不到回应的人不是嫌疑人，是布景。
 * 世界代写行为仅限无 agent 的 NPC（红线③只保护 cast），所以这里是合法的。
 *
 * 三档随试探次数递进（per「角色×NPC」计数随档）：
 * ①敷衍 ②不耐烦 ③+ 打发走；**只有案子已经公开、且这桩案的真凶正是他**时，
 * 第三次起才可能撞见**失言**——他否认了一件你压根没提过的事。
 * 失言前的公开门是信息隔离的闸：案子还没人知道就冒出否认，等于引擎泄底。
 *
 * 失言也只落"他说了什么"，不落"所以他是小偷"——要不要顺着这根线走归角色。
 * 返回 NPC 说出口的话（非静态 NPC / 未知角色返回 undefined，调用方据此判断有没有发生）。
 */
export function replyAsStaticNpc(
  deps: CrimeSupplyDeps,
  params: { speakerId: string; targetId: string },
): string | undefined {
  const { world, memory, tick } = deps;
  const ns = world.narrative;
  if (!ns.isStaticNpc(params.targetId)) return undefined;
  const npc = world.getCharacter(params.targetId);
  const speaker = world.getCharacter(params.speakerId);
  if (!npc || !speaker || ns.isNpc(params.speakerId)) return undefined;

  const ledger = ns.getCrimeSupplyLedger();
  const probeKey = `npc_probe_${params.targetId}_${params.speakerId}`;
  const probes = (ledger[probeKey] ?? 0) + 1;
  ledger[probeKey] = probes;

  // 失言资格：已公开的 open 案件里，真凶正是这个 NPC（真凶身份仍只在引擎账本，不进任何 prompt）
  const slipCase =
    probes >= NPC_PROBE_SLIP_AT
      ? ns.getPublicOpenCases().find((c) => c.perpId === params.targetId)
      : undefined;
  const slipVictim = slipCase ? world.getCharacter(slipCase.victimId) : undefined;

  let line: string;
  let importance = 4;
  if (slipCase && slipVictim && slipVictim.id !== params.speakerId) {
    line = `「我跟${slipVictim.name}那档子事没关系。」${npc.name}忽然冒出这么一句——你压根没提过${slipVictim.name}`;
    importance = 8;
  } else if (probes === 1) {
    line = `${npc.name}这才抬了下眼皮又低回去：「……啊？没听清。」`;
  } else if (probes === 2) {
    line = `「你们镇上的人怎么都爱打听。」${npc.name}把手往口袋里一插，「我找活干，行了吧。」`;
  } else {
    line = `${npc.name}冲你摆了摆手，转过身去，摆明了不想再搭话`;
  }

  memory.add(params.speakerId, {
    tick,
    type: "conversation",
    content: line,
    importance,
    relatedCharacterId: params.targetId,
  });

  if (slipCase && slipVictim && slipVictim.id !== params.speakerId && obsessionsEnabled()) {
    ns.registerObsession(params.speakerId, {
      id: `obs_${slipCase.id}_slip_${params.speakerId}`,
      summary: `${npc.name}自己把${slipVictim.name}的名字说出了口，而你从没提过。这句话你忘不掉`,
      createdDay: Math.floor(tick / TICKS_PER_DAY),
      decayDays: CRIME_LEAD_OBSESSION_DAYS,
      source: "crime",
      relatedId: slipCase.id,
    });
    console.log(`🕵️ [crime-supply] 失言：${npc.name} 对 ${params.speakerId} 说漏了 ${slipVictim.name}（第 ${probes} 次试探）`);
    world.chronicle.record({
      id: `chr_slip_${params.speakerId}_${tick}`,
      tick, day: Math.floor(tick / TICKS_PER_DAY),
      kind: "crime", importance: 10, emoji: "🗝️",
      title: `${npc.name}对${world.getCharacter(params.speakerId)?.name ?? params.speakerId}说漏了嘴——他否认了一件对方根本没提过的事`,
      detail: `第 ${probes} 次试探换来的。这是全局唯一一条能把嫌疑指向具体某人的线索。`,
      actors: [params.speakerId, npc.id],
    });
  }
  return line;
}

/** 把 steal 事件的 targetId（可能是 id/名字/"shop"）解析成 cast 角色 id；解析不出返回 undefined。 */
function resolveCastCharacter(world: World, raw: string): string | undefined {
  if (world.getCharacter(raw)) return raw;
  const lower = raw.toLowerCase();
  const byName = world.getAllCharacters().find((c) => c.name.toLowerCase() === lower);
  return byName?.id;
}
