import { describe, expect, it } from "vitest"

import {
  isProcessingDetailSelection,
  PROCESSING_DETAIL_SELECTION,
  resolveInitialSelection,
  resolveRequestedScope,
} from "./rule-selection"
import type { UnifiedRuleRow } from "./unified-action-list"

const row = (id: string, scope: UnifiedRuleRow["scope"]): Pick<UnifiedRuleRow, "id" | "scope"> => ({
  id,
  scope,
})

describe("resolveRequestedScope", () => {
  it("`?scope=cloud|local` 显式指定优先，与本机部署无关", () => {
    expect(resolveRequestedScope({ requested: "cloud", local: true })).toBe("cloud")
    expect(resolveRequestedScope({ requested: "cloud", local: false })).toBe("cloud")
    expect(resolveRequestedScope({ requested: "local", local: false })).toBe("local")
  })

  it("`?scope=processing_service` 只在本机部署生效", () => {
    expect(resolveRequestedScope({ requested: "processing_service", local: true })).toBe(
      "processing_service",
    )
    // 处理服务只在本机部署可用：其他环境不假装有能力
    expect(resolveRequestedScope({ requested: "processing_service", local: false })).toBeNull()
  })

  it("未指定或给了不认识的值时，本机部署默认进入处理服务，其余环境不选中", () => {
    expect(resolveRequestedScope({ requested: null, local: true })).toBe("processing_service")
    expect(resolveRequestedScope({ requested: "nope", local: true })).toBe("processing_service")
    expect(resolveRequestedScope({ requested: null, local: false })).toBeNull()
    expect(resolveRequestedScope({ requested: "nope", local: false })).toBeNull()
  })
})

describe("resolveInitialSelection", () => {
  it("选中请求执行位置下的第一条规则", () => {
    const rows = [row("cloud:0", "cloud"), row("cloud:1", "cloud")]
    expect(resolveInitialSelection({ scope: "cloud", rows, canOpenProcessingDetail: true })).toBe(
      "cloud:0",
    )
  })

  it("请求的执行位置没有规则、且不在本机部署时，不选中（交给空占位）", () => {
    expect(
      resolveInitialSelection({
        scope: "processing_service",
        rows: [row("cloud:0", "cloud")],
        canOpenProcessingDetail: false,
      }),
    ).toBeNull()
  })

  it("处理服务规则集为空时回落成详情面板——这是新建第一条处理服务规则的唯一路径", () => {
    expect(
      resolveInitialSelection({
        scope: "processing_service",
        rows: [row("cloud:0", "cloud")],
        canOpenProcessingDetail: true,
      }),
    ).toBe(PROCESSING_DETAIL_SELECTION)
  })

  it("处理服务已有规则时优先选中规则，不再用虚拟选中项", () => {
    expect(
      resolveInitialSelection({
        scope: "processing_service",
        rows: [row("cloud:0", "cloud"), row("processing_service:r1", "processing_service")],
        canOpenProcessingDetail: true,
      }),
    ).toBe("processing_service:r1")
  })

  it("未请求执行位置时不选中", () => {
    expect(
      resolveInitialSelection({
        scope: null,
        rows: [row("cloud:0", "cloud")],
        canOpenProcessingDetail: true,
      }),
    ).toBeNull()
  })

  it("虚拟选中项只认自己，不会把它当成规则 id", () => {
    expect(isProcessingDetailSelection(PROCESSING_DETAIL_SELECTION)).toBe(true)
    expect(isProcessingDetailSelection("processing_service:r1")).toBe(false)
    expect(isProcessingDetailSelection(null)).toBe(false)
  })
})
