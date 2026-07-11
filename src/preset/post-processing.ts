/**
 * 提示词后处理（Prompt Post-Processing）——一比一复刻 SillyTavern。
 * PLAN-tavern.md S2/S3。
 *
 * ST 在组装出消息数组后、发给 API 前，按 `custom_prompt_post_processing` 做一次后处理：
 * 合并同角色、强制对话交替、单一用户消息等。DeepSeek reasoner 等模型对消息角色排列有要求，常需开。
 *
 * 参考 ground truth：vendor/ST src/prompt-converters.js
 *   - postProcessPrompt(messages, type, names)  (行 83)
 *   - mergeMessages(messages, names, {strict, placeholders, single, tools})  (行 822)
 * 说明：Anima 为纯文本，省略 ST 里的图像 content-token 处理；tool 角色我们组装层不产出。
 */
import type { TavernMessage } from "./assembler.js";

export type PostProcessingType =
  | ""
  | "none"
  | "merge"
  | "claude"
  | "merge_tools"
  | "semi"
  | "semi_tools"
  | "strict"
  | "strict_tools"
  | "single";

export interface PostProcessNames {
  charName?: string;
  userName?: string;
  /** 群聊时判断内容是否已以某成员名开头；默认恒 false */
  startsWithGroupName?: (content: string) => boolean;
}

/** 与 ST 默认一致（config promptPlaceholder） */
export const PROMPT_PLACEHOLDER = "Let's get started.";

interface MergeOpts {
  strict?: boolean;
  placeholders?: boolean;
  single?: boolean;
}

/** 一比一复刻 ST mergeMessages（去掉图像/tool 分支） */
export function mergeMessages(
  input: TavernMessage[],
  names: PostProcessNames = {},
  { strict = false, placeholders = false, single = false }: MergeOpts = {},
): TavernMessage[] {
  const startsWithGroupName = names.startsWithGroupName ?? (() => false);
  // 克隆，避免改动入参
  const messages: TavernMessage[] = input.map((m) => ({ ...m }));

  // 1) 去 name → 前缀化 + single 角色归并
  for (const message of messages) {
    if (!message.content) message.content = "";

    if (message.name && message.role !== "system") {
      if (!message.content.startsWith(`${message.name}: `)) {
        message.content = `${message.name}: ${message.content}`;
      }
    }

    if (single) {
      if (message.role === "assistant") {
        if (
          names.charName &&
          !message.content.startsWith(`${names.charName}: `) &&
          !startsWithGroupName(message.content)
        ) {
          message.content = `${names.charName}: ${message.content}`;
        }
      }
      if (message.role === "user") {
        if (names.userName && !message.content.startsWith(`${names.userName}: `)) {
          message.content = `${names.userName}: ${message.content}`;
        }
      }
      message.role = "user";
    }

    delete message.name;
  }

  // 2) 合并相邻同角色（用 \n\n 拼接）
  const merged: TavernMessage[] = [];
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === message.role && message.content) {
      prev.content += "\n\n" + message.content;
    } else {
      merged.push(message);
    }
  }

  // 3) 空数组兜底
  if (merged.length === 0) {
    merged.unshift({ role: "user", content: PROMPT_PLACEHOLDER });
  }

  // 4) 严格交替
  if (strict) {
    for (let i = 0; i < merged.length; i++) {
      if (i > 0 && merged[i].role === "system") {
        merged[i].role = "user";
      }
    }
    if (merged.length && placeholders) {
      if (merged[0].role === "system" && (merged.length === 1 || merged[1].role !== "user")) {
        merged.splice(1, 0, { role: "user", content: PROMPT_PLACEHOLDER });
      } else if (merged[0].role !== "system" && merged[0].role !== "user") {
        merged.unshift({ role: "user", content: PROMPT_PLACEHOLDER });
      }
    }
    // 递归再合并一次（把刚变成 user 的相邻项收拢）
    return mergeMessages(merged, names, { strict: false, placeholders, single: false });
  }

  return merged;
}

/** 按 custom_prompt_post_processing 类型做后处理（一比一复刻 postProcessPrompt） */
export function postProcessPrompt(
  messages: TavernMessage[],
  type: PostProcessingType,
  names: PostProcessNames = {},
): TavernMessage[] {
  switch (type) {
    case "merge":
    case "claude":
    case "merge_tools":
      return mergeMessages(messages, names, {});
    case "semi":
    case "semi_tools":
      return mergeMessages(messages, names, { strict: true });
    case "strict":
    case "strict_tools":
      return mergeMessages(messages, names, { strict: true, placeholders: true });
    case "single":
      return mergeMessages(messages, names, { strict: true, single: true });
    default:
      return messages;
  }
}
