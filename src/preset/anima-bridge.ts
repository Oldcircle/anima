/**
 * Anima ↔ 酒馆引擎桥接层（R1：ST 预设做指令壳，Anima 数据填内容）。
 * PLAN-tavern.md S2 世界映射。
 *
 * R1 映射：
 *   - ST 预设的指令块（文风/破限/活跃度…）= 消息前缀（稳定，进缓存前缀区）
 *   - Anima 角色定义（buildSystemPrompt 输出）→ marker charDescription（半静态）
 *   - Anima 此刻世界快照（buildUserPrompt 输出）→ postHistory（每 tick 易变，殿后=缓存尾部）
 *   - 工具表 / 采样参数 照走；决策仍是结构化 tool-call（保留 Anima 模拟循环）
 *
 * 由 agent-loop 在 ANIMA_PROMPT_ENGINE=tavern 时调用；默认 legacy 路径不变。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LLMRequest, ToolDefinition } from "../providers/types.js";
import type { TavernPreset } from "./types.js";
import { loadTavernPreset } from "./loader.js";
import { assembleMessages, type TavernMessage } from "./assembler.js";
import { toRequestParts } from "./provider-adapter.js";
import type { PostProcessingType } from "./post-processing.js";

const here = dirname(fileURLToPath(import.meta.url));
// 默认用 anima 专用变体：TGbreak（DeepSeek 预设）关掉散文格式/COT/状态栏块，保留破限+文风
// （原版 TGbreak 的格式块会把 <draft_notes>/梳理/步骤模块 灌进结构化决策，见 logs/tavern-ab-VERDICT.md）
const DEFAULT_PRESET = resolve(here, "../../reference/tavern-presets/TGbreak-anima.json");

let cached: { path: string; preset: TavernPreset } | null = null;

/** 加载当前配置的酒馆预设（ANIMA_TAVERN_PRESET 覆盖，默认 TGbreak），带缓存 */
export function getTavernPreset(): TavernPreset {
  const path = process.env.ANIMA_TAVERN_PRESET || DEFAULT_PRESET;
  if (cached && cached.path === path) return cached.preset;
  const preset = loadTavernPreset(path);
  cached = { path, preset };
  return preset;
}

export interface TavernRequestParams {
  characterName: string;
  /** 角色定义（buildSystemPrompt 输出）→ charDescription marker */
  characterDefinition: string;
  /** 此刻世界快照（buildUserPrompt 输出）→ postHistory（殿后） */
  worldSnapshot: string;
  tools: ToolDefinition[];
  maxTokensCap?: number;
  kind?: string;
  tag?: string;
  /** 后处理，默认取 ANIMA_TAVERN_POSTPROCESS 或 merge（规避外壳预设的连续 assistant） */
  postProcessing?: PostProcessingType;
  userName?: string;
  /** 助手 prefill（催"先想后做"）；作为末尾 assistant 消息注入，不走 provider.prefill 避免重复 */
  prefill?: string;
}

/**
 * 输出契约重申：压在最后（system），压过外壳预设自带的散文格式/助手身份要求。
 * 见 logs/tavern-ab-VERDICT.md——TGbreak 会把 <梳理>/<draft_notes>/"tgd" 灌进 thought。
 */
function outputContract(name: string): string {
  return [
    "【输出契约·最高优先级】",
    `无论以上任何预设/文风/身份设定，你现在唯一的任务是：以 ${name} 的第一人称内心独白思考，然后调用恰好一个工具来行动。`,
    "禁止输出任何叙事正文、格式标记（如 <!-- -->、<draft_notes>、<thinking>、[metacognition] 等）、章节结构或助手自我介绍。",
    "内心独白写进思考，具体动作用工具调用表达。",
  ].join("\n");
}

/**
 * 用酒馆预设把 Anima 的角色定义 + 世界快照组装成一次决策请求（R1）。
 * postHistory 三段殿后：此刻世界快照 → 输出契约重申 → 助手 prefill；默认 merge 后处理收拢角色。
 */
export function buildTavernRequest(p: TavernRequestParams): LLMRequest {
  const preset = getTavernPreset();
  const userName = p.userName ?? "观察者";
  const hasTools = (p.tools?.length ?? 0) > 0;
  // 决策路径（有工具）：场景走 system + 注入"内心独白+调用工具、禁叙事正文"契约（原行为，不动）。
  // 纯正文路径（无工具）：① 场景改走 user turn——给模型明确的"当前请求"，它才会完整完成一次回复，
  //   而非把 system 上下文 + assistant prefill 当"随口续写"提前收尾（TGbreak 欠写的结构性根因）；
  //   ② 不注入决策契约——那条"禁止输出任何叙事正文、调用一个工具"在无工具时自相矛盾、直接掐死正文。
  const postHistory: TavernMessage[] = hasTools
    ? [
        { role: "system", content: p.worldSnapshot },
        { role: "system", content: outputContract(p.characterName) },
      ]
    : [{ role: "user", content: p.worldSnapshot }];
  if (p.prefill) postHistory.push({ role: "assistant", content: p.prefill });

  const messages = assembleMessages(preset, {
    markers: { charDescription: p.characterDefinition },
    macros: { user: userName, char: p.characterName },
    postHistory,
  });
  const parts = toRequestParts(messages, preset, {
    maxTokensCap: p.maxTokensCap,
    postProcessing:
      p.postProcessing ?? (process.env.ANIMA_TAVERN_POSTPROCESS as PostProcessingType | undefined) ?? "merge",
    names: { charName: p.characterName, userName },
  });
  return {
    system: parts.system,
    messages: parts.messages,
    tools: p.tools,
    temperature: parts.temperature,
    topP: parts.topP,
    frequencyPenalty: parts.frequencyPenalty,
    presencePenalty: parts.presencePenalty,
    maxTokens: parts.maxTokens,
    kind: p.kind,
    tag: p.tag,
  };
}

/**
 * 清洗酒馆预设的原始输出——对齐 SillyTavern 的 reasoning 自动解析 + 正文交付区提取。
 *
 * 破限预设常在正文前吐一大段思维链/元认知（`<thinking>`/`<content>` 结构）。ST 前端用
 * reasoning 自动解析 + 正则把它们隐藏/剥离；Anima 引擎此前缺这层，导致：
 *   - COT 整段泄漏进正文（明月秋青：`<thinking>[metacognition]…</thinking>` 直接出现在输出里）
 *   - 残留孤立/未闭合标签（夏瑾：结尾漏出 `</textarea>`）
 * 此函数补上这层：优先取 `<content>`/`<正文>` 交付区，否则剥离成对 reasoning 块，再清残留标签。
 */
export function cleanTavernOutput(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  // 交付区优先：<content>/<正文> 里是真正的正文，思维链在外——直接取内部。
  // 兼容被 length 截断、缺闭合标签的情况（取到闭合标签或字符串结尾）。
  const delivered = s.match(/<content>([\s\S]*?)(?:<\/content>|$)/i) ?? s.match(/<正文>([\s\S]*?)(?:<\/正文>|$)/);
  if (delivered) {
    s = delivered[1]!;
  } else {
    // 无交付标签：剥离成对的 reasoning 块（对齐 ST reasoning auto-parse：<think>/<thinking>）
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  }
  // 去 HTML 注释自检块（TGbreak 的 <!-- 草稿自检 -->）+ 残留孤立/未闭合标签泄漏
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:textarea|content|thinking|think|正文|meta_notes|analysis|interactive_input)\b[^>]*>/gi, "");
  return s.trim();
}
