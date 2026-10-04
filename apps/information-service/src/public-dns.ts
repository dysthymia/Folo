import type { LookupAddress } from "node:dns"
import { request } from "node:https"
import { isIP } from "node:net"

import { z } from "zod"

const endpoint = "https://cloudflare-dns.com/dns-query"
const resolverIp = "1.1.1.1"
const MAX_DNS_BYTES = 16_384
// 不同解析实现隔离缓存，测试桩不能污染正式解析地址。
const caches = new WeakMap<Query, Map<string, { expiresAt: number; addresses: LookupAddress[] }>>()
const answerSchema = z.object({
  Status: z.number().int(),
  TC: z.boolean(),
  Question: z.array(z.object({ name: z.string(), type: z.number().int() })).length(1),
  Answer: z
    .array(
      z.object({
        name: z.string(),
        type: z.number().int(),
        TTL: z.number().nonnegative(),
        data: z.string(),
      }),
    )
    .max(100)
    .optional(),
})
type Query = (url: URL, signal: AbortSignal) => Promise<unknown>
export class PublicDnsError extends Error {
  constructor(public readonly code: "unavailable" | "invalid_response" | "unsafe_address") {
    super(code)
  }
}

// 只接受已知公网命名空间的全部 benchmark Fake-IP；真实私网、内网命名和混合结果永不回退。
function isPublicHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, "")
  if (
    isIP(name) ||
    !/^[a-z0-9.-]+$/u.test(name) ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|corp|intranet|arpa|test|example|invalid)(?:\.|$)/u.test(
      name,
    ) ||
    !/\.(?:com|org|net|edu|gov|info|biz|dev|app|io|ai|me|co|cn|uk|jp|de|fr|au|ca|us|ch|nl|se|no|fi|dk|ie|it|es|in|br|za|nz|hk|tw|sg|kr|cc|tv|ly|to|sh|gg|be|at|pl|pt|ru|ua|id|tr|mx|il|gr|cz|xyz|tech|cloud|blog|online|site|wiki|live|one|social|systems|network|tools|software|engineering|science|academy|digital|news)$/u.test(
      name,
    )
  )
    return false
  return true
}

export function isFakeIpResolution(hostname: string, addresses: readonly LookupAddress[]): boolean {
  if (!isPublicHostname(hostname)) return false
  return (
    addresses.length > 0 &&
    addresses.every(({ address }) => {
      if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number)
        return a === 198 && (b === 18 || b === 19)
      }
      if (isIP(address) === 6) {
        const [a, b, c] = address.split(":")
        return (
          Number.parseInt(a!, 16) === 0x2001 &&
          Number.parseInt(b || "0", 16) === 2 &&
          Number.parseInt(c || "0", 16) === 0
        )
      }
      return false
    })
  )
}

function queryJson(url: URL, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        agent: false,
        signal,
        rejectUnauthorized: true,
        servername: "cloudflare-dns.com",
        headers: { Accept: "application/dns-json" },
        // HTTPS 固定公网 resolver IP，TLS 仍核验官方 hostname；不受本机 Fake-IP 再次重绑定。
        lookup: (_host, options, callback) => {
          const address = { address: resolverIp, family: 4 }
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^application\/(?:dns-json|json)(?:;|$)/iu.test(res.headers["content-type"] ?? "")
        ) {
          res.destroy()
          reject(new PublicDnsError("unavailable"))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_DNS_BYTES) {
            res.destroy()
            reject(new PublicDnsError("invalid_response"))
          } else chunks.push(chunk)
        })
        res.on("error", () => reject(new PublicDnsError("unavailable")))
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch {
            reject(new PublicDnsError("invalid_response"))
          }
        })
      },
    )
    req.on("error", () => reject(new PublicDnsError("unavailable")))
    req.end()
  })
}

// 官方 JSON GET 接口：https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
// A/AAAA 并行且共用外层八秒期限；所有地址核验后才按最短 TTL 缓存，最多一分钟。
export async function resolveTrustedPublicDns(
  hostname: string,
  signal: AbortSignal,
  validate: (address: string) => boolean,
  query: Query = queryJson,
): Promise<LookupAddress[]> {
  signal.throwIfAborted()
  if (!isPublicHostname(hostname)) throw new PublicDnsError("unsafe_address")
  let cache = caches.get(query)
  if (!cache) {
    cache = new Map()
    caches.set(query, cache)
  }
  const previous = cache.get(hostname)
  if (previous && previous.expiresAt > Date.now())
    return previous.addresses.map((item) => ({ ...item }))
  const responses = await Promise.all(
    [1, 28].map(async (type) => {
      const url = new URL(endpoint)
      url.searchParams.set("name", hostname)
      url.searchParams.set("type", String(type))
      const parsed = answerSchema.safeParse(await query(url, signal))
      if (
        !parsed.success ||
        parsed.data.Status !== 0 ||
        parsed.data.TC ||
        parsed.data.Question[0]!.name.toLowerCase().replace(/\.$/u, "") !==
          hostname.toLowerCase().replace(/\.$/u, "") ||
        parsed.data.Question[0]!.type !== type
      )
        throw new PublicDnsError("invalid_response")
      return parsed.data.Answer ?? []
    }),
  )
  signal.throwIfAborted()
  const records = responses.flat().filter((item) => item.type === 1 || item.type === 28)
  if (
    !records.length ||
    records.some((item) => !validate(item.data) || isIP(item.data) !== (item.type === 1 ? 4 : 6))
  )
    throw new PublicDnsError("unsafe_address")
  const addresses = [
    ...new Map(
      records.map((item) => [item.data, { address: item.data, family: item.type === 1 ? 4 : 6 }]),
    ).values(),
  ]
  cache.set(hostname, {
    addresses,
    expiresAt: Date.now() + Math.min(60_000, ...records.map((item) => item.TTL * 1000)),
  })
  if (cache.size > 100) cache.delete(cache.keys().next().value!)
  return addresses.map((item) => ({ ...item }))
}
