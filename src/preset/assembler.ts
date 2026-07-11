/**
 * 酒馆预设组装器：`prompt_order` → 有序消息数组（ST Chat Completion 语义，一比一复刻）。
 * PLAN-tavern.md S1。
 *
 * 忠实实现 ST 的组装规则：
 * - 按 prompt_order 逐条渲染，enabled=false 跳过；
 * - marker 块替换成动态内容（角色卡/对话），非 marker 块出 {role, content} 并做 {{macro}} 替换；
 * - send_if_empty="" 语义：内容为空的块丢弃（chatHistory/postHistory 例外，原样保留）；
 * - squash_system_messages：合并相邻 system 消息；
 * - postHistory（Anima 决策指令+此刻世界快照）永远追加在最末尾 → 锁死缓存易变尾部。
 *
 * 输出是 ST 原生消息（含 system 角色）；转成 Anima provider 的 {system, messages} 由 S2 适配层做。
 */
import type { TavernPreset, PromptRole } from "./types.js";
import { orderForCharacter } from "./loader.js";

export interface TavernMessage {
  role: PromptRole;
  content: string;
  /** 可选发言者名（ST names_behavior）；带 name 的 system 消息不参与 squash */
  name?: string;
}

/** 8 个 marker 的填充内容（chatHistory 是消息序列，其余是文本） */
export interface MarkerContent {
  worldInfoBefore?: string;
  personaDescription?: string;
  charDescription?: string;
  charPersonality?: string;
  scenario?: string;
  worldInfoAfter?: string;
  dialogueExamples?: string;
  chatHistory?: TavernMessage[];
}

export interface AssembleOptions {
  characterId?: number;
  markers?: MarkerContent;
  /** {{user}}/{{char}}/... → 实际值（键大小写不敏感）；未知宏原样保留 */
  macros?: Record<string, string>;
  /** 追加在最末尾的块（Anima 工具菜单+此刻世界快照）——永远殿后，缓存尾部 */
  postHistory?: TavernMessage[];
  /** 覆盖预设的 squash_system_messages；默认取预设值 */
  squashSystem?: boolean;
  /** 空内容块是否丢弃（ST send_if_empty="" 语义），默认 true */
  dropEmpty?: boolean;
}

const MACRO_RE = /\{\{([a-zA-Z_][\w]*)\}\}/g;

/** 替换 {{key}} 宏；键大小写不敏感；未知宏原样保留（不静默吞内容） */
export function substituteMacros(text: string, macros: Record<string, string> = {}): string {
  if (!text) return text;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(macros)) lower[k.toLowerCase()] = v;
  return text.replace(MACRO_RE, (whole, key: string) => {
    const v = lower[key.toLowerCase()];
    return v !== undefined ? v : whole;
  });
}

/**
 * 合并相邻 system 消息（ST squash_system_messages，一比一复刻其规则）：
 * - 丢弃空 system 消息；
 * - 仅当 role==='system' 且无 name 时可 squash（带 name 的不合并）；
 * - 相邻两条都可 squash 时用换行拼接。
 * 参考：vendor/ST public/scripts/openai.js ChatCompletion.squashSystemMessages()
 * （ST 另有 excludeList=['newMainChat','newChat','groupNudge'] 内部标识符，Anima 不产出，故略）。
 */
export function squashSystemMessages(msgs: TavernMessage[]): TavernMessage[] {
  const canSquash = (m: TavernMessage) => m.role === "system" && !m.name;
  const out: TavernMessage[] = [];
  let last: TavernMessage | null = null;
  for (const m of msgs) {
    if (m.role === "system" && !m.content) continue; // 丢空 system
    if (canSquash(m) && last && canSquash(last)) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      const copy = { ...m };
      out.push(copy);
      last = copy;
    }
  }
  return out;
}

/**
 * 按预设的 prompt_order 组装出有序消息数组。
 */
export function assembleMessages(preset: TavernPreset, opts: AssembleOptions = {}): TavernMessage[] {
  const order = orderForCharacter(preset, opts.characterId);
  const byId = new Map(preset.prompts.map((p) => [p.identifier, p]));
  const markers = opts.markers ?? {};
  const macros = opts.macros ?? {};
  const dropEmpty = opts.dropEmpty ?? true;

  const out: TavernMessage[] = [];
  const push = (role: PromptRole, content: string | undefined) => {
    const c = content ?? "";
    if (dropEmpty && c.trim() === "") return;
    out.push({ role, content: c });
  };

  for (const entry of order.order) {
    if (!entry.enabled) continue;
    const block = byId.get(entry.identifier);
    if (!block) continue;

    if (block.marker) {
      switch (block.identifier) {
        case "chatHistory":
          for (const m of markers.chatHistory ?? []) out.push({ ...m });
          break;
        case "worldInfoBefore":
          push(block.role, markers.worldInfoBefore);
          break;
        case "worldInfoAfter":
          push(block.role, markers.worldInfoAfter);
          break;
        case "personaDescription":
          push(block.role, markers.personaDescription);
          break;
        case "charDescription":
          push(block.role, markers.charDescription);
          break;
        case "charPersonality":
          push(block.role, markers.charPersonality);
          break;
        case "scenario":
          push(block.role, markers.scenario);
          break;
        case "dialogueExamples":
          push(block.role, markers.dialogueExamples);
          break;
        default:
          // 未知 marker：忽略（未来接世界书等）
          break;
      }
    } else {
      push(block.role, substituteMacros(block.content ?? "", macros));
    }
  }

  // Anima 决策块永远殿后（缓存易变尾部）
  for (const m of opts.postHistory ?? []) out.push({ ...m });

  const squash =
    opts.squashSystem ?? preset.raw.squash_system_messages === true;
  return squash ? squashSystemMessages(out) : out;
}

/**
 * 缓存前缀 = 组装结果里 chatHistory 与 postHistory 之前的静态部分。
 * 用于回归测试：只要角色卡/预设不变，改动对话或此刻快照都不该扰动这个前缀。
 * 返回从头到「第一条 chatHistory 消息」之前的静态消息（不含对话与决策块）。
 */
export function staticPrefix(
  preset: TavernPreset,
  opts: Omit<AssembleOptions, "chatHistory" | "postHistory"> & { markers?: MarkerContent },
): TavernMessage[] {
  // 组装但不给 chatHistory / postHistory —— 得到纯静态前缀
  const markers = { ...(opts.markers ?? {}) };
  delete (markers as MarkerContent).chatHistory;
  return assembleMessages(preset, { ...opts, markers, chatHistory: undefined, postHistory: undefined } as AssembleOptions);
}
