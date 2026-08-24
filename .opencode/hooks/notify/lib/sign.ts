/**
 * Shared HMAC-SHA256 signing for webhook channels (design §1.3).
 * DingTalk: key=secret, message=`${ms}\n${secret}` → base64 (URL-encoded by caller).
 * Feishu:   key=`${seconds}\n${secret}`, message="" → base64.
 */
import { createHmac } from "node:crypto"

function hmacB64(key: string, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("base64")
}

export function dingtalkSignB64(secret: string, ms: number): string {
  return hmacB64(secret, `${ms}\n${secret}`)
}

export function feishuSignB64(secret: string, tsSeconds: string): string {
  return hmacB64(`${tsSeconds}\n${secret}`, "")
}
