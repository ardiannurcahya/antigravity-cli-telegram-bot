import dns from "node:dns/promises";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { splitMessage } from "./markdown-renderer.js";

function parseIpv6(addr: string): bigint | null {
  let clean = addr.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (clean.startsWith("::ffff:")) {
    const v4 = clean.substring(7);
    if (isIP(v4) === 4) {
      const parts = v4.split(".").map(Number);
      return (BigInt(0xffff) << 32n) | (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]);
    }
  }
  if (!clean.includes(":")) return null;
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  let left: number[] = [];
  let right: number[] = [];
  if (halves[0]) {
    left = halves[0].split(":").map((h) => parseInt(h || "0", 16));
  }
  if (halves.length === 2 && halves[1]) {
    right = halves[1].split(":").map((h) => parseInt(h || "0", 16));
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = [...left, ...new Array(missing).fill(0), ...right];
  let result = 0n;
  for (const part of full) {
    result = (result << 16n) | BigInt(part);
  }
  return result;
}

function ipv6InRange(ip: string, cidrBase: string, prefixLen: number): boolean {
  const ipInt = parseIpv6(ip);
  const baseInt = parseIpv6(cidrBase);
  if (ipInt === null || baseInt === null) return false;
  const mask = ((1n << BigInt(prefixLen)) - 1n) << BigInt(128 - prefixLen);
  return (ipInt & mask) === (baseInt & mask);
}

export function isPrivateOrReservedIp(ip: string): boolean {
  let cleanIp = ip.toLowerCase().trim().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (cleanIp === "::1" || cleanIp === "::" || cleanIp === "0.0.0.0") return true;
  if (cleanIp.startsWith("::ffff:")) {
    cleanIp = cleanIp.substring(7);
  }
  const ipVersion = isIP(cleanIp);
  if (ipVersion === 4) {
    const parts = cleanIp.split(".").map(Number);
    const [b0, b1, b2, b3] = parts;
    if (b0 > 255 || b1 > 255 || b2 > 255 || b3 > 255) return true;
    if (b0 === 0 || b0 === 10 || b0 === 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    if (b0 === 192 && b1 === 0 && b2 === 0) return true;
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;
    if (b0 >= 224) return true;
  } else if (ipVersion === 6) {
    if (cleanIp === "::1" || cleanIp === "::") return true;
    if (ipv6InRange(cleanIp, "fc00::", 7)) return true; // ULA
    if (ipv6InRange(cleanIp, "fe80::", 10)) return true; // Link-local
    if (ipv6InRange(cleanIp, "fec0::", 10)) return true; // Site-local
    if (ipv6InRange(cleanIp, "::ffff:0:0", 96)) return true; // IPv4-mapped
    if (ipv6InRange(cleanIp, "64:ff9b::", 96)) return true; // NAT64
    if (ipv6InRange(cleanIp, "2001:db8::", 32)) return true; // Documentation
    if (ipv6InRange(cleanIp, "2001::", 23)) return true; // IETF Protocol
    if (ipv6InRange(cleanIp, "2002::", 16)) return true; // 6to4
  }
  return false;
}

export async function isPrivateOrReservedHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().trim().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  if (isPrivateOrReservedIp(host)) {
    return true;
  }
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses || addresses.length === 0) return true;
    return addresses.some(({ address }) => isPrivateOrReservedIp(address));
  } catch {
    return true;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isAllowedLocalMediaPath(filePath: string, workspaceDir?: string): boolean {
  const resolved = path.resolve(filePath);
  const tempDir = path.resolve(os.tmpdir());
  const varTmp = path.resolve("/var/tmp");
  const brainDir = path.resolve(os.homedir(), ".gemini/antigravity-cli/brain");
  const stateDir = path.resolve(os.homedir(), ".local/state/agy-telegram");
  const varLibDir = path.resolve("/var/lib/agy-telegram");
  if (
    isWithin(tempDir, resolved) ||
    isWithin(varTmp, resolved) ||
    isWithin(brainDir, resolved) ||
    isWithin(stateDir, resolved) ||
    isWithin(varLibDir, resolved)
  ) return true;
  if (workspaceDir && isWithin(workspaceDir, resolved)) return true;
  return false;
}

export async function findReferencedMediaFiles(text: string, workspaceDir?: string): Promise<string[]> {
  const candidates = new Set<string>();

  // 1. Markdown image embeds: ![caption](/path/to/img.png) or ![caption](file:///path/to/img.png)
  const mdImgRegex = /!\[.*?\]\((?:file:\/\/)?([^\s)]+?\.(?:png|jpe?g|webp|gif|svg))\)/gi;
  for (const match of text.matchAll(mdImgRegex)) {
    const rawPath = match[1].trim();
    candidates.add(rawPath);
  }

  // 2. HTML img tags: <img src="/path/to/img.png">
  const htmlImgRegex = /<img[^>]+src=["'](?:file:\/\/)?([^"']+\.(?:png|jpe?g|webp|gif|svg))["']/gi;
  for (const match of text.matchAll(htmlImgRegex)) {
    const rawPath = match[1].trim();
    candidates.add(rawPath);
  }

  // 3. MEDIA: tags (e.g. MEDIA:/path/to/img.png from skills or tools)
  const mediaTagRegex = /\bMEDIA:(?:file:\/\/)?([^\s\n\r"']+\.(?:png|jpe?g|webp|gif|svg))\b/gi;
  for (const match of text.matchAll(mediaTagRegex)) {
    candidates.add(match[1].trim());
  }

  // 4. Explicit saved-to labels (e.g. "Screenshot saved to: /path/to/img.png")
  const savedToRegex = /(?:screenshot|image)(?:\s+saved\s+to)?:\s*(?:file:\/\/)?([^\s\n\r"']+\.(?:png|jpe?g|webp|gif|svg))\b/gi;
  for (const match of text.matchAll(savedToRegex)) {
    candidates.add(match[1].trim());
  }

  // 5. Temporary / state / brain preview images
  const mediaPathRegex = /(?:^|[\s"'`(\[])(\/(?:tmp|var\/tmp)[^\s"'`)\]]+\.(?:png|jpe?g|webp|gif|svg))/gi;
  for (const match of text.matchAll(mediaPathRegex)) {
    candidates.add(match[1].trim());
  }

  const validFiles: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) continue;
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : (workspaceDir ? path.resolve(workspaceDir, candidate) : path.resolve(candidate));
    if (!isAllowedLocalMediaPath(resolved, workspaceDir)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile() && stat.size > 0 && stat.size < 50 * 1024 * 1024) {
        if (!validFiles.includes(resolved)) {
          validFiles.push(resolved);
        }
      }
    } catch {
      // file does not exist locally, skip
    }
  }

  // 4. Public Web Images: ![caption](https://example.com/image.png) or https://.../img.jpg
  const webImgRegex = /!?\[.*?\]\((https?:\/\/[^\s)]+?\.(?:png|jpe?g|webp|gif|svg))\)|(?:^|[\s"'`(\[])(https?:\/\/[^\s"'`)\]]+?\.(?:png|jpe?g|webp|gif|svg))/gi;
  for (const match of text.matchAll(webImgRegex)) {
    const webUrl = (match[1] || match[2] || "").trim();
    if (!webUrl) continue;
    try {
      const parsedUrl = new URL(webUrl);
      if (await isPrivateOrReservedHost(parsedUrl.hostname)) continue;

      const ext = path.extname(parsedUrl.pathname).toLowerCase() || ".jpg";
      const hash = Buffer.from(webUrl).toString("base64url").slice(0, 24);
      const targetPath = path.join(os.tmpdir(), `web_media_${hash}${ext}`);
      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat || stat.size === 0) {
        const res = await fetch(webUrl, { redirect: "manual", signal: AbortSignal.timeout(8000) });
        if ([301, 302, 303, 307, 308].includes(res.status)) continue;
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length < 20 * 1024 * 1024) { // max 20MB
            await fs.writeFile(targetPath, buffer);
          }
        }
      }
      const finalStat = await fs.stat(targetPath).catch(() => null);
      if (finalStat && finalStat.size > 0 && !validFiles.includes(targetPath)) {
        validFiles.push(targetPath);
      }
    } catch {
      // ignore download failure
    }
  }

  return validFiles;
}
