/**
 * Mock LLM Provider — 测试用
 */

import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "../../src/providers/types.js";

export interface MockLLMCall {
  modelId: string;
  request: LLMRequest;
}

export class MockLLMProvider implements LLMProvider {
  readonly id = "mock";
  private _responses: LLMResponse[] = [];
  private _calls: MockLLMCall[] = [];
  private _defaultResponse: LLMResponse = {
    content: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  /** 设置下次调用的返回值（队列模式） */
  enqueueResponse(content: string, toolCalls: ToolCall[] = []): void {
    this._responses.push({
      content,
      toolCalls,
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  }

  /** 设置默认返回值（队列为空时使用） */
  setDefaultResponse(content: string, toolCalls: ToolCall[] = []): void {
    this._defaultResponse = {
      content,
      toolCalls,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  /** 获取所有调用记录 */
  get calls(): ReadonlyArray<MockLLMCall> {
    return this._calls;
  }

  /** 重置状态 */
  reset(): void {
    this._responses = [];
    this._calls = [];
  }

  async chat(request: LLMRequest, modelId: string): Promise<LLMResponse> {
    this._calls.push({ modelId, request });
    return this._responses.shift() ?? { ...this._defaultResponse };
  }
}
