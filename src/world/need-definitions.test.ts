import { describe, it, expect } from "vitest";
import { formatBodyFeelings } from "./need-definitions.js";

const fullNeeds = { hunger: 100, energy: 100, social: 60, fun: 100, hygiene: 100, bladder: 100 };

describe("formatBodyFeelings 生活节律", () => {
  it("午饭点 + 肚子不满时惦记午饭", () => {
    const text = formatBodyFeelings({ ...fullNeeds, hunger: 55 }, 100, 12);
    expect(text).toContain("午饭");
  });

  it("刚吃饱时到了饭点也不催饭", () => {
    const text = formatBodyFeelings({ ...fullNeeds, hunger: 90 }, 100, 12);
    expect(text).not.toContain("午饭");
  });

  it("早上提示早饭", () => {
    const text = formatBodyFeelings({ ...fullNeeds, hunger: 50 }, 100, 7);
    expect(text).toContain("早饭");
  });

  it("傍晚提示晚饭", () => {
    const text = formatBodyFeelings({ ...fullNeeds, hunger: 50 }, 100, 18);
    expect(text).toContain("晚饭");
  });

  it("非饭点不提饭", () => {
    const text = formatBodyFeelings({ ...fullNeeds, hunger: 55 }, 100, 15);
    expect(text).not.toContain("午饭");
    expect(text).not.toContain("早饭");
    expect(text).not.toContain("晚饭");
  });

  it("深夜生物钟提示仍然生效", () => {
    const text = formatBodyFeelings(fullNeeds, 100, 2);
    expect(text).toContain("深夜");
  });
});
