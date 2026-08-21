/**
 * Scenario Sim Harness — 剧本感知的验收 sim runner（DESIGN-revival §6 步骤 2）
 *
 * 与 cli.ts 同一条装配路径：scenario-loader → World → Simulation → loadBeats →
 * applySeeds → phase 工具 → （可选）Director。live 验收测试与 SmartMock 离线彩排共用，
 * 保证"测的就是生产装配"。
 *
 * 成本闸（live 用）：maxLLMCalls 硬顶——每 tick 结束后检查调用数，达到即主动停跑保数据
 * （杜绝跑到一半 402 死档）。SmartMock 离线跑不设顶即可。
 *
 * 全局态纪律：setBreakLevel/setDecisionPov 是进程级全局，harness 按 manifest 设置并在
 * dispose() 恢复原值——测试文件用完必须 dispose，否则污染同文件后续用例。
 */

import { join } from "node:path";
import { World } from "../../src/world/world.js";
import { EventBus } from "../../src/core/event-bus.js";
import { Simulation, type TickSummary } from "../../src/agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../../src/actions/basic-actions.js";
import { ALL_TRIAL_ACTIONS, PHASE_TOOL_WHITELIST } from "../../src/actions/trial-actions.js";
import { ALL_KIRA_ACTIONS } from "../../src/actions/kira-actions.js";
import {
  loadScenario,
  applyInitialItems,
  applyKiraProtections,
  type LoadedScenario,
} from "../../src/narrative/scenario-loader.js";
import {
  getBreakLevel,
  setBreakLevel,
  getDecisionPov,
  setDecisionPov,
  type BreakLevel,
  type DecisionPov,
} from "../../src/agent/break-config.js";
import { addToInventory } from "../../src/world/item-registry.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/providers/types.js";
import type { ActionDefinition } from "../../src/actions/types.js";

/** provider 计数包装：硬顶检查的数据源（对 live 与 mock 一视同仁） */
class CountingProvider implements LLMProvider {
  readonly id: string;
  count = 0;
  constructor(private readonly inner: LLMProvider) {
    this.id = inner.id;
  }
  async chat(request: LLMRequest, modelId: string): Promise<LLMResponse> {
    this.count++;
    return this.inner.chat(request, modelId);
  }
}

export interface ScenarioSimOptions {
  scenarioId: string;
  provider: LLMProvider;
  /** 模型 id（live 验收锁 deepseek-chat；mock 随意） */
  modelId?: string;
  /** 默认取仓库根（本文件相对路径推导） */
  projectRoot?: string;
  /** 开始 tick，默认 24（day 1 06:00，与 cli 一致） */
  startTick?: number;
  /** LLM 调用硬顶：每 tick 末检查，达到即停跑保数据。缺省 = 不设顶 */
  maxLLMCalls?: number;
  /** 是否应用 seeds（读档续跑场景传 false），默认 true */
  applySeeds?: boolean;
  /** 启用 LLM Director（走同一个 counting provider，计入硬顶） */
  director?: { dailyBudget?: number };
  /** 覆盖 manifest 的 break_level / decision_pov（测试 A/B 用） */
  breakLevel?: BreakLevel;
  decisionPov?: DecisionPov;
  /** 附加行为工具（默认 ALL_BASIC_ACTIONS） */
  actions?: ActionDefinition[];
}

export interface ScenarioRunResult {
  summaries: TickSummary[];
  /** 是否因 LLM 硬顶提前停跑 */
  stoppedEarly: boolean;
}

export interface ScenarioSimHandle {
  sim: Simulation;
  world: World;
  eventBus: EventBus;
  scenario: LoadedScenario;
  /** 到目前为止的 LLM 调用总数（含 director） */
  llmCalls(): number;
  /** 从当前进度继续跑 N tick（内部维护 tick 游标，可多次调用续跑） */
  run(ticks: number): Promise<ScenarioRunResult>;
  /** 下一个待跑 tick（save/load 往返后对齐用） */
  nextTick(): number;
  /** 强制设置 tick 游标（loadGame 恢复进度后调用） */
  setNextTick(tick: number): void;
  /** 恢复 breakLevel/decisionPov 全局态——用完必须调 */
  dispose(): void;
}

export function createScenarioSim(options: ScenarioSimOptions): ScenarioSimHandle {
  const projectRoot = options.projectRoot ?? join(import.meta.dirname, "..", "..");
  const scenario = loadScenario(options.scenarioId, { projectRoot });
  const modelId = options.modelId ?? "smart-mock";
  const startTick = options.startTick ?? 24;

  // 全局态：按 manifest（或显式覆盖）设置，dispose 恢复
  const prevBreak = getBreakLevel();
  const prevPov = getDecisionPov();
  setBreakLevel(options.breakLevel ?? scenario.manifest.breakLevel);
  setDecisionPov(options.decisionPov ?? scenario.manifest.decisionPov);

  const provider = new CountingProvider(options.provider);
  const world = new World(scenario.locations, startTick);
  for (const card of scenario.characters) {
    world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    if (card.startingItems) {
      const state = world.getCharacter(card.id);
      if (state) {
        for (const itemId of card.startingItems) addToInventory(state.inventory, itemId);
      }
    }
  }
  applyInitialItems(world, scenario.manifest);
  applyKiraProtections(world, scenario.manifest);

  const eventBus = new EventBus();
  const sim = new Simulation(world, eventBus, {
    characters: scenario.characters,
    actions: options.actions ?? ALL_BASIC_ACTIONS,
    provider,
    modelId,
  });

  if (scenario.beats.length > 0) sim.loadBeats(scenario.beats);

  // B3 罪行供给器：与 cli 同款装配（manifest crime_supply）
  sim.configureCrimeSupply(scenario.manifest.crimeSupply);

  // phase 工具与 cli 同款（koukou trial/investigation + kira 夜书）
  {
    const phaseTools: Record<string, typeof ALL_TRIAL_ACTIONS> = {};
    for (const [phase, names] of Object.entries(PHASE_TOOL_WHITELIST)) {
      phaseTools[phase] = ALL_TRIAL_ACTIONS.filter((a) => names.includes(a.tool.name));
    }
    phaseTools["kira"] = ALL_KIRA_ACTIONS;
    sim.registerPhaseTools(phaseTools);
  }

  if ((options.applySeeds ?? true) && scenario.seeds) {
    sim.applySeeds(scenario.seeds);
  }

  if (options.director) {
    sim.enableDirector({
      provider,
      modelId,
      dailyBudget: options.director.dailyBudget ?? 5,
    });
  }

  let cursor = startTick;
  let disposed = false;

  // 追求：角色卡的 pursuit 进运行期（与 cli 同款装配）

  sim.initPursuits();


  return {
    sim,
    world,
    eventBus,
    scenario,
    llmCalls: () => provider.count,
    nextTick: () => cursor,
    setNextTick: (tick: number) => {
      cursor = tick;
    },
    async run(ticks: number): Promise<ScenarioRunResult> {
      const { tickToGameTime } = await import("../../src/core/tick-engine.js");
      const summaries: TickSummary[] = [];
      let stoppedEarly = false;
      for (let i = 0; i < ticks; i++) {
        if (options.maxLLMCalls !== undefined && provider.count >= options.maxLLMCalls) {
          console.warn(
            `⛔ [scenario-sim] LLM 调用数 ${provider.count} 已达硬顶 ${options.maxLLMCalls}，提前停跑保数据（已跑 ${i}/${ticks} tick）`,
          );
          stoppedEarly = true;
          break;
        }
        const summary = await sim.runOneTick(tickToGameTime(cursor));
        summaries.push(summary);
        cursor++;
      }
      await sim.waitForBackgroundTasks();
      return { summaries, stoppedEarly };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      setBreakLevel(prevBreak);
      setDecisionPov(prevPov);
    },
  };
}
