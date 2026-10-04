import { describe, expect, it } from "vitest"

import type { SourceEntry } from "./folo"
import {
  inspectMaterialContext,
  missingMaterialContext,
  requiredMaterialLinks,
} from "./material-context"

const entry: SourceEntry = {
  id: "1",
  sourceKey: "feed/x",
  title: "短公告",
  url: "https://x.com/example/status/1",
  publishedAt: "2026-01-01T00:00:00Z",
  read: false,
  content: "今日发布新版本。",
  description: null,
}

describe("X 材料完整性保护", () => {
  it("短公告、自足正文和装饰图片无需按字数或附件数量补上下文", () => {
    expect(missingMaterialContext(entry)).toEqual([])
    expect(
      missingMaterialContext({
        ...entry,
        content: `${entry.content}<img src="https://example/decorative">`,
        imageCount: 1,
      }),
    ).toEqual([])
    expect(
      missingMaterialContext({
        ...entry,
        content: `${"版本现在支持ARM设备，安装命令与迁移步骤如下。".repeat(20)}<img src="https://example/chart">`,
      }),
    ).toEqual([])
    expect(
      missingMaterialContext({
        ...entry,
        content:
          '<p>教程详细步骤见原文。</p><a href="https://x.com/author/status/2">有效教程链接</a>',
      }),
    ).toEqual(["links"])
  })
  it("普通status链接与推荐串文不代表引用或线程缺失", () => {
    expect(
      missingMaterialContext({
        ...entry,
        content: '官方发布了版本3，详情见 <a href="https://x.com/official/status/2">官方公告</a>。',
      }),
    ).toEqual([])
    expect(
      missingMaterialContext({ ...entry, content: "推荐这篇thread，完整线程链接供进一步阅读。" }),
    ).toEqual([])
  })
  // 明确正文依赖才触发链接补读；仅声明 complete 或只登记URL都不算读取过材料。
  it("教程/报告的真实外链待补，不误拦普通新闻外链和营销引流", () => {
    const tutorial = {
      ...entry,
      content: '<p>完整教程详见原文：<a href="https://learn.example.com/guide">迁移指南</a></p>',
    }
    expect(requiredMaterialLinks(tutorial)).toEqual(["https://learn.example.com/guide"])
    expect(missingMaterialContext({ ...tutorial, context: { links: "complete" } })).toEqual([
      "links",
    ])
    expect(
      missingMaterialContext({
        ...entry,
        content: '<p>版本今天发布。<a href="https://learn.example.com/news">官方新闻</a></p>',
      }),
    ).toEqual([])
    expect(
      requiredMaterialLinks({
        ...entry,
        content: "<p>关注我私信领取完整教程。</p>",
      }),
    ).toEqual([])
    const linked = {
      url: "https://learn.example.com/guide",
      resolvedUrl: "https://learn.example.com/guide",
      title: "指南",
      content: "先备份数据库再迁移。",
      status: "complete" as const,
      failure: null,
    }
    expect(missingMaterialContext({ ...tutorial, linkedMaterials: [linked] })).toEqual(["links"])
    expect(
      inspectMaterialContext({
        ...tutorial,
        originalContent: tutorial.content,
        linkedMaterials: [linked],
        content: `${tutorial.content}<p>先备份数据库再迁移。</p>`,
      }).verified.links,
    ).toBe("complete")
  })
  it("纯文本URL去句尾标点，带返佣/转发但提供完整公开教程仍补读", () => {
    expect(
      requiredMaterialLinks({
        ...entry,
        content: "完整教程详细步骤见 https://learn.example.com/guide。",
      }),
    ).toEqual(["https://learn.example.com/guide"])
    expect(
      requiredMaterialLinks({
        ...entry,
        content:
          "报告全文详见 https://learn.example.com/report；\n相关新闻 https://news.example.com/next。",
      }),
    ).toEqual(["https://learn.example.com/report"])
    expect(
      requiredMaterialLinks({
        ...entry,
        content:
          '<p>教程含返佣，转发可支持作者；完整教程详见 <a href="https://learn.example.com/guide">公开指南</a></p>',
      }),
    ).toEqual(["https://learn.example.com/guide"])
    expect(
      requiredMaterialLinks({
        ...entry,
        content: "纯拉新广告，返佣链接 https://learn.example.com/ad。",
      }),
    ).toEqual([])
  })
  it("多链接只补明确依赖的段落，目标去重且普通相关链接保留", () => {
    const tutorial = {
      ...entry,
      content:
        '<p>完整教程详见 <a href="https://learn.example.com/guide#one">指南</a>，<a href="https://learn.example.com/guide#two">同一指南</a></p><p><a href="https://news.example.com/">相关新闻</a></p>',
    }
    expect(requiredMaterialLinks(tutorial)).toEqual(["https://learn.example.com/guide"])
  })
  // Newsletter 已有完整文章时，尾部推荐报告不代表本文正文待补；旧链接失败也需恢复。
  it("完整长文章的尾部Full Report推荐不抓取或阻断正文", () => {
    const article = {
      ...entry,
      url: "https://news.example.com/newsletter",
      content:
        `<h1>Crypto for Advisors</h1>${`<p>${"Portfolio diversification, custody and allocation decisions are discussed in this article. ".repeat(12)}</p>`.repeat(3)}` +
        '<aside><p>A related research report.</p><p><a href="https://news.example.com/related-report">View Full Report</a></p></aside>',
      context: { links: "failed" as const },
    }
    expect(requiredMaterialLinks(article)).toEqual([])
    expect(missingMaterialContext(article)).toEqual([])
  })
  it("长摘录明确省略关键步骤或声明截断时仍补实际完整版", () => {
    const content = `<p>${"这篇指南说明了迁移背景、兼容限制和已知问题。".repeat(45)}</p>`.repeat(3)
    const url = "https://news.example.com/excerpt"
    for (const cue of [
      "本文仅提供摘要，完整指南详见",
      "指南详细步骤见原文",
      "指南正文截断，展开全文，完整指南详见",
    ]) {
      const excerpt = {
        ...entry,
        url,
        content: `${content}<p>${cue} <a href="https://learn.example.com/guide">完整指南</a></p>`,
      }
      expect(requiredMaterialLinks(excerpt)).toEqual(["https://learn.example.com/guide"])
      expect(missingMaterialContext(excerpt)).toEqual(["links"])
    }
  })
  it("实际嵌入原帖正文可核验quote完整，只有不可用引用才待补", () => {
    const embedded = {
      ...entry,
      content:
        '<p>这次发布值得关注。</p><blockquote><p>版本3今天发布，新增ARM支持，已有用户按迁移指南升级。</p><a href="https://x.com/official/status/2">原帖时间</a></blockquote>',
    }
    expect(inspectMaterialContext(embedded)).toEqual({
      missing: [],
      verified: { quote: "complete" },
    })
    expect(
      missingMaterialContext({
        ...entry,
        content:
          '<p>引用原帖未读取</p><blockquote><a href="https://x.com/official/status/2">Quoted tweet</a></blockquote>',
      }),
    ).toEqual(["quote"])
  })
  it("完整编号串文才核验thread完整，缺段与未加载仍待补", () => {
    const full = {
      ...entry,
      content: "<p>1/2 串文：版本新增ARM。</p><p>2/2 迁移先备份再安装。</p>",
    }
    expect(inspectMaterialContext(full)).toEqual({ missing: [], verified: { thread: "complete" } })
    expect(
      missingMaterialContext({ ...entry, content: "<p>1/3 串文：这次发布的前置条件。</p>" }),
    ).toEqual(["thread"])
    expect(missingMaterialContext({ ...entry, content: "线程内容未加载。" })).toEqual(["thread"])
  })
  it("依赖关键图表的短说明待补，不把下载图片当成看过图片", () => {
    const material = {
      ...entry,
      content: '<p>关键收益数据见图表。</p><img src="https://example/chart">',
    }
    expect(missingMaterialContext(material)).toEqual(["images"])
    expect(inspectMaterialContext(material).verified.images).toBeUndefined()
    expect(missingMaterialContext({ ...material, context: { images: "complete" } })).toEqual([])
    expect(missingMaterialContext({ ...material, context: { images: "failed" } })).toEqual([
      "images",
    ])
  })
})
