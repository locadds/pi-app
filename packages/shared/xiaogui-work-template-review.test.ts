import { describe, expect, it } from "vitest";

import {
  isValidTemplateReviewTextRangeV2,
  validateTemplateReviewSplitV2,
} from "./xiaogui-work-template-review";

describe("xiaogui work template review V2 contract", () => {
  it("accepts a positive half-open UTF-16 range", () => {
    expect(
      isValidTemplateReviewTextRangeV2({ startUtf16: 0, endUtf16Exclusive: 1 }),
    ).toBe(true);
    expect(
      isValidTemplateReviewTextRangeV2({ startUtf16: 1, endUtf16Exclusive: 1 }),
    ).toBe(false);
    expect(
      isValidTemplateReviewTextRangeV2({
        startUtf16: -1,
        endUtf16Exclusive: 2,
      }),
    ).toBe(false);
  });

  it("allows adjacent split ranges and rejects overlaps", () => {
    expect(
      validateTemplateReviewSplitV2({
        targetId: "target-1",
        ranges: [
          { startUtf16: 3, endUtf16Exclusive: 6 },
          { startUtf16: 0, endUtf16Exclusive: 3 },
        ],
      }),
    ).toBe(true);

    expect(
      validateTemplateReviewSplitV2({
        targetId: "target-1",
        ranges: [
          { startUtf16: 0, endUtf16Exclusive: 4 },
          { startUtf16: 3, endUtf16Exclusive: 6 },
        ],
      }),
    ).toBe(false);
  });
});
