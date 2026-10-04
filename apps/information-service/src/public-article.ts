import type { LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"

import { parseHTML } from "linkedom"

import { isFakeIpResolution, PublicDnsError, resolveTrustedPublicDns } from "./public-dns"
import { sourceText } from "./service"

const MAX_BYTES = 1_000_000
const MAX_TEXT = 40_000
const MAX_REDIRECTS = 3
export type PublicArticle = { url: string; title: string | null; text: string }
export class PublicArticleError extends Error {
  constructor(
    public readonly code:
      | "unsafe_url"
      | "timeout"
      | "network"
      | "upstream"
      | "unsupported_type"
      | "too_large"
      | "empty"
      | "redirect_limit",
  ) {
    // 只保留错误分类，公开材料中的正文或网络头不会进入错误日志。
    super(code)
  }
}
type PublicPage = {
  status: number
  location: string | null
  contentType: string | null
  body: string
}
type Transport = (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<PublicPage>

// DNS 返回的每个地址都必须公开；IPv6 仅允许全球单播且排除文档与隧道网段。
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (family !== 6) return false
  const [first, second] = address.toLowerCase().split(":")
  const prefix = Number.parseInt(first!, 16)
  return (
    prefix >= 0x2000 &&
    prefix <= 0x3fff &&
    prefix !== 0x2002 &&
    !(
      prefix === 0x2001 &&
      (Number.parseInt(second || "0", 16) < 0x200 || Number.parseInt(second || "0", 16) === 0xdb8)
    )
  )
}

function publicUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PublicArticleError("unsafe_url")
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "")
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443") ||
    /(?:^|\.)(?:localhost|local|internal|home|invalid|test|example)$/iu.test(hostname) ||
    (isIP(hostname) && !isPublicAddress(hostname))
  )
    throw new PublicArticleError("unsafe_url")
  url.hash = ""
  return url
}

function loadPage(url: URL, address: LookupAddress, signal: AbortSignal): Promise<PublicPage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "Folo-Material-Reader/1.0" },
        // 固定连接到已核验地址，保留原 hostname 的 Host/SNI；不携带官方 API 的令牌或 Cookie。
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        const contentType = response.headers["content-type"] ?? null
        const location = response.headers.location ?? null
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy()
          resolve({ status, contentType, location, body: "" })
          return
        }
        if (status < 200 || status >= 300) {
          response.destroy()
          reject(new PublicArticleError("upstream"))
          return
        }
        if (
          !contentType ||
          !/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/iu.test(contentType)
        ) {
          response.destroy()
          reject(new PublicArticleError("unsupported_type"))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_BYTES) {
            response.destroy()
            reject(new PublicArticleError("too_large"))
          } else chunks.push(chunk)
        })
        response.on("error", () => reject(new PublicArticleError("network")))
        response.on("end", () => {
          try {
            const charset = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1] ?? "utf-8"
            resolve({
              status,
              contentType,
              location,
              body: new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks)),
            })
          } catch {
            reject(new PublicArticleError("unsupported_type"))
          }
        })
      },
    )
    request.on("error", () =>
      reject(new PublicArticleError(signal.aborted ? "timeout" : "network")),
    )
    request.end()
  })
}

// 仅获取明确依赖的公开正文，不执行网页脚本；每一跳重新核验 DNS，整个请求共用八秒期限。
export async function readPublicArticle(
  value: string,
  options: {
    signal?: AbortSignal
    resolve?: (hostname: string) => Promise<LookupAddress[]>
    load?: Transport
    trustedResolve?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>
  } = {},
): Promise<PublicArticle> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(8_000),
    ...(options.signal ? [options.signal] : []),
  ])
  const resolve =
    options.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
  const seen = new Set<string>()
  let url = publicUrl(value)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (signal.aborted) throw new PublicArticleError("timeout")
    if (seen.has(url.href)) throw new PublicArticleError("redirect_limit")
    seen.add(url.href)
    const hostname = url.hostname.replace(/^\[|\]$/gu, "")
    let onAbort: () => void = () => {}
    let addresses: LookupAddress[]
    try {
      addresses = await Promise.race([
        resolve(hostname),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new PublicArticleError("timeout"))
          signal.addEventListener("abort", onAbort, { once: true })
          // 监听注册与上次检查之间发生的取消也必须立即退出 DNS 等待。
          if (signal.aborted) onAbort()
        }),
      ])
    } catch (error) {
      if (error instanceof PublicArticleError) throw error
      throw new PublicArticleError("network")
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    if (
      addresses.some((item) => !isPublicAddress(item.address)) &&
      isFakeIpResolution(hostname, addresses)
    ) {
      try {
        addresses = await (
          options.trustedResolve ??
          ((name, activeSignal) => resolveTrustedPublicDns(name, activeSignal, isPublicAddress))
        )(hostname, signal)
      } catch (error) {
        if (signal.aborted) throw new PublicArticleError("timeout")
        throw new PublicArticleError(
          error instanceof PublicDnsError && error.code === "unsafe_address"
            ? "unsafe_url"
            : "network",
        )
      }
    }
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
      throw new PublicArticleError("unsafe_url")
    const page = await (options.load ?? loadPage)(url, addresses[0]!, signal)
    if (signal.aborted) throw new PublicArticleError("timeout")
    if ([301, 302, 303, 307, 308].includes(page.status)) {
      if (!page.location || redirects === MAX_REDIRECTS)
        throw new PublicArticleError("redirect_limit")
      url = publicUrl(new URL(page.location, url).href)
      continue
    }
    if (page.status < 200 || page.status >= 300) throw new PublicArticleError("upstream")
    if (
      !page.contentType ||
      !/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/iu.test(page.contentType)
    )
      throw new PublicArticleError("unsupported_type")
    if (Buffer.byteLength(page.body) > MAX_BYTES) throw new PublicArticleError("too_large")
    let text: string,
      title: string | null = null
    if (/^text\/plain(?:;|$)/iu.test(page.contentType)) text = page.body.trim()
    else {
      const { document } = parseHTML(page.body)
      title = document.querySelector("title")?.textContent?.trim() || null
      for (const node of document.querySelectorAll(
        "script,style,noscript,iframe,nav,header,footer,aside,form",
      ))
        node.remove()
      // 优先正文容器，避免把导航/登录文案当成教程；没有正文结构时仅接受多个正文段落。
      const main = document.querySelector("article,main,[role=main]")
      const paragraphs = [...document.querySelectorAll("p,pre,h1,h2,h3,li")]
      if (!main && paragraphs.filter((node) => node.tagName === "P").length < 2)
        throw new PublicArticleError("empty")
      text = sourceText(main?.innerHTML ?? paragraphs.map((node) => node.outerHTML).join("\n"))
    }
    if (
      !text ||
      /^(?:access denied|just a moment|enable javascript|sign in to continue)/iu.test(text)
    )
      throw new PublicArticleError("empty")
    // 超长正文保持待补，不把截断过的文本冒充完整材料。
    if (text.length > MAX_TEXT) throw new PublicArticleError("too_large")
    return { url: url.href, title, text }
  }
  throw new PublicArticleError("redirect_limit")
}
