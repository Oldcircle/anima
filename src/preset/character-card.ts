/**
 * 酒馆角色卡兼容层：读 ST/TavernCard 的 PNG 与 JSON 卡片（V1 扁平 / V2 chara_card_v2 / V3 chara_card_v3），
 * 归一化成统一结构，并抽出预设 marker 需要的内容。
 * PLAN-tavern.md S2（角色卡兼容）。
 *
 * 参考 ground truth：vendor/ST public/scripts/char-data.js（V2/V3 spec）与 PNG tEXt `chara`/`ccv3` 约定。
 */
import { readFileSync } from "node:fs";
import type { MarkerContent } from "./assembler.js";

/** 归一化后的角色卡（字段对齐 ST V2/V3 data 块） */
export interface CharacterCard {
  spec: "v1" | "chara_card_v2" | "chara_card_v3";
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  creator_notes: string;
  creator: string;
  tags: string[];
  /** 备用问候（V2+） */
  alternate_greetings: string[];
  /** 原始 JSON 备查（世界书 character_book / extensions 等未归一化的都在这） */
  raw: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 从 PNG buffer 里抽出嵌入的角色卡 JSON 字符串。
 * ST 约定：tEXt/iTXt chunk，关键字 `ccv3`（V3，优先）或 `chara`（V1/V2），内容是 base64(JSON)。
 */
export function extractCardJsonFromPng(buf: Buffer): string {
  // PNG 签名校验
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error("不是有效的 PNG 文件");
  }
  const texts = new Map<string, string>(); // keyword -> base64 text
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buf.length) break;
    if (type === "tEXt") {
      const data = buf.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        const keyword = data.toString("latin1", 0, nul);
        const text = data.toString("latin1", nul + 1);
        texts.set(keyword, text);
      }
    } else if (type === "iTXt") {
      const data = buf.subarray(dataStart, dataEnd);
      // iTXt: keyword \0 compFlag(1) compMethod(1) langTag \0 translatedKeyword \0 text
      const nul1 = data.indexOf(0);
      if (nul1 >= 0) {
        const keyword = data.toString("latin1", 0, nul1);
        const compFlag = data[nul1 + 1];
        const nul2 = data.indexOf(0, nul1 + 3);
        const nul3 = nul2 >= 0 ? data.indexOf(0, nul2 + 1) : -1;
        if (nul3 >= 0 && compFlag === 0) {
          texts.set(keyword, data.toString("utf8", nul3 + 1));
        }
      }
    }
    if (type === "IEND") break;
    off = dataEnd + 4; // 跳过 CRC
  }
  const b64 = texts.get("ccv3") ?? texts.get("chara");
  if (!b64) throw new Error("PNG 里没有找到角色卡数据（缺 ccv3/chara tEXt chunk）");
  return Buffer.from(b64.trim(), "base64").toString("utf8");
}

/** 解析角色卡 JSON（自动识别 V1 扁平 / V2 / V3） */
export function parseCharacterCard(json: string): CharacterCard {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const spec = str(raw.spec);
  // V2/V3：真实字段在 data 块；V1：字段在顶层
  const isV2plus = spec === "chara_card_v2" || spec === "chara_card_v3";
  const d = (isV2plus && typeof raw.data === "object" && raw.data
    ? (raw.data as Record<string, unknown>)
    : raw);

  return {
    spec: spec === "chara_card_v3" ? "chara_card_v3" : spec === "chara_card_v2" ? "chara_card_v2" : "v1",
    name: str(d.name),
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    first_mes: str(d.first_mes),
    mes_example: str(d.mes_example),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    creator_notes: str(d.creator_notes ?? d.creatorcomment),
    creator: str(d.creator),
    tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
    alternate_greetings: Array.isArray(d.alternate_greetings)
      ? (d.alternate_greetings as unknown[]).map(String)
      : [],
    raw,
  };
}

/** 从文件加载角色卡（按扩展名分派 .png / .json） */
export function loadCharacterCard(filePath: string): CharacterCard {
  if (/\.png$/i.test(filePath)) {
    return parseCharacterCard(extractCardJsonFromPng(readFileSync(filePath)));
  }
  return parseCharacterCard(readFileSync(filePath, "utf-8"));
}

/**
 * 从角色卡抽出预设 marker 内容（charDescription/charPersonality/scenario/dialogueExamples）。
 * 各字段先做 {{macro}} 替换（ST substituteParams 语义）。first_mes / post_history_instructions
 * 由调用方另行处理（前者进 chatHistory、后者进 postHistory）。
 */
export function cardToMarkers(
  card: CharacterCard,
  macros: Record<string, string> = {},
): MarkerContent {
  const sub = (t: string) => substitute(t, { ...macros, char: macros.char ?? card.name });
  return {
    charDescription: sub(card.description),
    charPersonality: sub(card.personality),
    scenario: sub(card.scenario),
    dialogueExamples: sub(card.mes_example),
  };
}

const MACRO_RE = /\{\{([a-zA-Z_][\w]*)\}\}/g;
function substitute(text: string, macros: Record<string, string>): string {
  if (!text) return text;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(macros)) lower[k.toLowerCase()] = v;
  return text.replace(MACRO_RE, (whole, key: string) => {
    const v = lower[key.toLowerCase()];
    return v !== undefined ? v : whole;
  });
}
