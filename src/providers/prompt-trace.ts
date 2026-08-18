/**
 * Prompt Trace — 提示词追踪（观察者通道，对齐 Claude Code 的 prompt 追踪）
 *
 * anima 本身就是个 agent 系统：每 tick 每角色都在拼 prompt、调工具、吃 token。
 * 但此前想看"这一次到底喂了什么进去"只有两条路——翻控制台，或开 `ANIMA_PROMPT_DUMP=1`
 * 把请求体落盘再手工 diff。两条都是离线的、事后的、要人肉对齐的。
 *
 * 这一层把它变成在线的：进程内环形缓冲记下每次调用的**完整输入输出 + usage + 缓存命中**，
 * 前端按 kind/角色筛着看。项目的杀手级需求不是"看看 prompt"，而是**缓存纪律的归因**：
 *
 *   DeepSeek 自动前缀缓存按逐字节匹配——命中率掉了，一定是某处动态内容回流进了前缀。
 *   `prefixBreak` 拿本次的 tools+system 和**上一次同 (kind,tag,model) 的**逐字节比，
 *   报出第一个分歧的字节位置与上下文。命中率从 70% 掉到 2% 的那种事故，
 *   以前要落盘 + diff 两个 JSON 才能定位，现在面板上直接指出"第 2874 字节，在工具表里"。
 *
 * 纪律：
 * - **默认开但有上限**：环形缓冲 `ANIMA_PROMPT_TRACE_KEEP` 条（默认 200，=0 整层关闭），
 *   单条文本超 `MAX_TEXT_BYTES` 截断并标记——长跑 2700 次调用不能把内存吃穿
 * - **零业务耦合**：provider 单向写入，模拟核心不知道它存在；记录失败绝不影响调用
 * - 这是观察者通道，不进任何角色 prompt
 */

import type { LLMRequest, LLMResponse, ToolCall } from "./types.js";

/** 单条记录里每段文本的字节上限，超出截断（长 prompt 装配动辄 20KB+） */
export const MAX_TEXT_BYTES = 24_000;
/** 默认保留条数 */
export const DEFAULT_KEEP = 200;

export interface PromptTraceMessage {
  role: string;
  content: string;
  truncated?: boolean;
  /** assistant 发起的工具调用名 */
  toolCallNames?: string[];
}

export interface PrefixBreak {
  /** 与之比较的上一条记录 id；无同键前驱时 undefined */
  comparedToId?: string;
  /** 前缀（tools+system）是否逐字节一致 */
  identical: boolean;
  /** 首个分歧的字节位置（identical=true 时为 -1） */
  atByte: number;
  /** 前缀总字节数 */
  prefixBytes: number;
  /** 分歧处上下文：上一条 / 本条各截一小段 */
  prevSnippet?: string;
  nextSnippet?: string;
  /** 分歧落在哪一段：工具表还是 system */
  section?: "tools" | "system";
}

export interface PromptTraceRecord {
  id: string;
  seq: number;
  /** 记录时刻的游戏 tick（由模拟循环 setTick 告知；未接线时 undefined） */
  tick?: number;
  /** 墙钟耗时（ms） */
  durationMs: number;
  kind: string;
  tag?: string;
  model: string;
  system: string;
  systemTruncated?: boolean;
  messages: PromptTraceMessage[];
  toolNames: string[];
  toolsJson: string;
  toolsTruncated?: boolean;
  maxTokens?: number;
  temperature?: number;
  prefill?: string;
  /** 响应侧（失败时 error 有值、content 为空） */
  content: string;
  contentTruncated?: boolean;
  toolCalls: ToolCall[];
  finishReason?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  };
  /** 缓存命中率（0-1）；无 usage 时 undefined */
  cacheHitRate?: number;
  /** 前缀字节数（工具表 JSON + system），缓存纪律的分母 */
  prefixBytes: number;
  prefixBreak: PrefixBreak;
}

/** 列表用的瘦身摘要（不带任何长文本） */
export interface PromptTraceSummary {
  id: string;
  seq: number;
  tick?: number;
  durationMs: number;
  kind: string;
  tag?: string;
  model: string;
  toolCount: number;
  messageCount: number;
  prefixBytes: number;
  prefixIdentical: boolean;
  prefixBreakAt: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitRate?: number;
  finishReason?: string;
  error?: string;
  /** 响应首行，列表里一眼看出这次做了什么 */
  preview: string;
}

export interface KindStats {
  kind: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  /** 命中 token / 输入 token */
  cacheHitRate: number;
  avgDurationMs: number;
  errors: number;
  /** 该桶里前缀与前一次不一致的次数——缓存纪律的直接体检项 */
  prefixBreaks: number;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function clip(s: string): { text: string; truncated?: boolean } {
  if (utf8Bytes(s) <= MAX_TEXT_BYTES) return { text: s };
  const cut = Buffer.from(s, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
  return { text: cut + "\n（已截断）", truncated: true };
}

/** 前缀 = 工具表 JSON + system。这两段就是 DeepSeek 前缀缓存实际比对的内容 */
function buildPrefix(toolsJson: string, system: string): string {
  return toolsJson + " " + system;
}

/**
 * 逐字节找首个分歧位置，-1 表示逐字节一致。
 * 用 Buffer 比而不是字符串——缓存按字节匹配，中文一个字 3 字节，
 * 按字符报位置会和实际偏移对不上。
 */
export function firstDivergence(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return i;
  }
  return ba.length === bb.length ? -1 : n;
}

function snippetAt(s: string, byteOffset: number, span = 90): string {
  const buf = Buffer.from(s, "utf8");
  const start = Math.max(0, byteOffset - span);
  const end = Math.min(buf.length, byteOffset + span);
  return buf.subarray(start, end).toString("utf8");
}

export class PromptTraceStore {
  private _records: PromptTraceRecord[] = [];
  private _seq = 0;
  private _keep: number;
  /** (kind,tag,model) → 上一条记录的前缀，用于前缀断点比对 */
  private _lastPrefix = new Map<string, { id: string; prefix: string; toolsBytes: number }>();
  private _tick?: number;

  constructor(keep = resolveKeep()) {
    this._keep = keep;
  }

  get enabled(): boolean {
    return this._keep > 0;
  }

  /** 模拟循环每 tick 告知当前游戏时间，记录里就能带上 tick（不接也能用） */
  setTick(tick: number): void {
    this._tick = tick;
  }

  /**
   * 记录一次调用。失败路径也记（error 有值）——白丢的调用最需要被看见。
   * 任何内部异常都吞掉：观察层绝不能弄坏被观察的东西。
   */
  record(input: {
    request: LLMRequest;
    model: string;
    durationMs: number;
    response?: LLMResponse;
    error?: string;
  }): PromptTraceRecord | undefined {
    if (!this.enabled) return undefined;
    try {
      return this._record(input);
    } catch {
      return undefined;
    }
  }

  private _record(input: {
    request: LLMRequest;
    model: string;
    durationMs: number;
    response?: LLMResponse;
    error?: string;
  }): PromptTraceRecord {
    const { request, model, durationMs, response, error } = input;
    const kind = request.kind ?? "unknown";
    const toolsJson = request.tools && request.tools.length > 0 ? JSON.stringify(request.tools) : "";
    const prefix = buildPrefix(toolsJson, request.system);
    const prefixKey = `${kind} ${request.tag ?? ""} ${model}`;
    const prev = this._lastPrefix.get(prefixKey);

    let prefixBreak: PrefixBreak;
    if (!prev) {
      // 首次见到这个 (kind,角色,模型) 组合：没有前驱可比，不算断点
      prefixBreak = { identical: false, atByte: 0, prefixBytes: utf8Bytes(prefix) };
    } else {
      const at = firstDivergence(prev.prefix, prefix);
      prefixBreak = at < 0
        ? { comparedToId: prev.id, identical: true, atByte: -1, prefixBytes: utf8Bytes(prefix) }
        : {
            comparedToId: prev.id,
            identical: false,
            atByte: at,
            prefixBytes: utf8Bytes(prefix),
            prevSnippet: snippetAt(prev.prefix, at),
            nextSnippet: snippetAt(prefix, at),
            section: at < prev.toolsBytes ? "tools" : "system",
          };
    }

    const id = `p${++this._seq}`;
    this._lastPrefix.set(prefixKey, { id, prefix, toolsBytes: utf8Bytes(toolsJson) });

    const sys = clip(request.system);
    const tools = clip(toolsJson);
    const content = clip(response?.content ?? "");
    const usage = response?.usage;
    const cacheHitRate = usage && usage.inputTokens > 0
      ? (usage.cacheHitTokens ?? 0) / usage.inputTokens
      : undefined;

    const rec: PromptTraceRecord = {
      id,
      seq: this._seq,
      tick: this._tick,
      durationMs: Math.round(durationMs),
      kind,
      tag: request.tag,
      model,
      system: sys.text,
      systemTruncated: sys.truncated,
      messages: request.messages.map((m) => {
        const raw = typeof (m as { content?: unknown }).content === "string" ? (m as { content: string }).content : "";
        const c = clip(raw);
        const calls = (m as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls;
        return {
          role: m.role,
          content: c.text,
          truncated: c.truncated,
          toolCallNames: calls?.map((t) => t.function.name),
        };
      }),
      toolNames: (request.tools ?? []).map((t) => t.name),
      toolsJson: tools.text,
      toolsTruncated: tools.truncated,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      prefill: request.prefill,
      content: content.text,
      contentTruncated: content.truncated,
      toolCalls: response?.toolCalls ?? [],
      finishReason: response?.finishReason,
      error,
      usage,
      cacheHitRate,
      prefixBytes: prefixBreak.prefixBytes,
      prefixBreak,
    };

    this._records.push(rec);
    if (this._records.length > this._keep) this._records.splice(0, this._records.length - this._keep);
    return rec;
  }

  /** 列表：默认最新在前 */
  list(filter?: { kind?: string; tag?: string; limit?: number }): PromptTraceSummary[] {
    let rows = this._records;
    if (filter?.kind) rows = rows.filter((r) => r.kind === filter.kind);
    if (filter?.tag) rows = rows.filter((r) => r.tag === filter.tag);
    const limit = filter?.limit ?? 100;
    return rows.slice(-limit).reverse().map((r) => ({
      id: r.id,
      seq: r.seq,
      tick: r.tick,
      durationMs: r.durationMs,
      kind: r.kind,
      tag: r.tag,
      model: r.model,
      toolCount: r.toolNames.length,
      messageCount: r.messages.length,
      prefixBytes: r.prefixBytes,
      prefixIdentical: r.prefixBreak.identical,
      prefixBreakAt: r.prefixBreak.atByte,
      inputTokens: r.usage?.inputTokens,
      outputTokens: r.usage?.outputTokens,
      cacheHitRate: r.cacheHitRate,
      finishReason: r.finishReason,
      error: r.error,
      preview: (r.error ? `✗ ${r.error}` : r.toolCalls[0]?.name ? `→ ${r.toolCalls[0].name}` : r.content)
        .replace(/\s+/g, " ").slice(0, 80),
    }));
  }

  get(id: string): PromptTraceRecord | undefined {
    return this._records.find((r) => r.id === id);
  }

  /** 按 kind 聚合。前缀不一致次数只统计有前驱可比的记录（首次调用不算断点） */
  stats(): { total: KindStats; byKind: KindStats[]; kinds: string[]; tags: string[] } {
    const acc = new Map<string, KindStats>();
    const blank = (kind: string): KindStats => ({
      kind, calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
      cacheHitRate: 0, avgDurationMs: 0, errors: 0, prefixBreaks: 0,
    });
    const total = blank("（全部）");
    let totalDuration = 0;
    const durationByKind = new Map<string, number>();

    for (const r of this._records) {
      let s = acc.get(r.kind);
      if (!s) { s = blank(r.kind); acc.set(r.kind, s); }
      s.calls++; total.calls++;
      s.inputTokens += r.usage?.inputTokens ?? 0; total.inputTokens += r.usage?.inputTokens ?? 0;
      s.outputTokens += r.usage?.outputTokens ?? 0; total.outputTokens += r.usage?.outputTokens ?? 0;
      s.cacheHitTokens += r.usage?.cacheHitTokens ?? 0; total.cacheHitTokens += r.usage?.cacheHitTokens ?? 0;
      if (r.error) { s.errors++; total.errors++; }
      if (r.prefixBreak.comparedToId && !r.prefixBreak.identical) { s.prefixBreaks++; total.prefixBreaks++; }
      durationByKind.set(r.kind, (durationByKind.get(r.kind) ?? 0) + r.durationMs);
      totalDuration += r.durationMs;
    }
    for (const s of acc.values()) {
      s.cacheHitRate = s.inputTokens > 0 ? s.cacheHitTokens / s.inputTokens : 0;
      s.avgDurationMs = s.calls > 0 ? Math.round((durationByKind.get(s.kind) ?? 0) / s.calls) : 0;
    }
    total.cacheHitRate = total.inputTokens > 0 ? total.cacheHitTokens / total.inputTokens : 0;
    total.avgDurationMs = total.calls > 0 ? Math.round(totalDuration / total.calls) : 0;

    return {
      total,
      byKind: [...acc.values()].sort((a, b) => b.calls - a.calls),
      kinds: [...acc.keys()].sort(),
      tags: [...new Set(this._records.map((r) => r.tag).filter((t): t is string => !!t))].sort(),
    };
  }

  clear(): void {
    this._records = [];
    this._lastPrefix.clear();
  }

  get size(): number {
    return this._records.length;
  }
}

function resolveKeep(): number {
  const raw = process.env.ANIMA_PROMPT_TRACE_KEEP;
  if (raw === undefined) return DEFAULT_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEP;
}

/** 进程级单例：provider 单向写入，API 只读 */
export const promptTrace = new PromptTraceStore();
