/**
 * Windows 10 desktop toast via WSL interop powershell.exe (design §1.3).
 * The whole ToastXML travels as ONE UTF-8→base64 argument (no quote hell);
 * XML escaping happens TS-side; WinRT types must be type-loaded with the
 * ContentType=WindowsRuntime accelerator before `::new()` (New-Object fails on WinRT).
 */
import type { Channel, SendCtx } from "./registry"
import { resolvePowerShellExe, runPowerShell } from "../lib/powershell"

const DEFAULT_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

export function toastXml(title: string, body: string): string {
  return `<toast><visual><binding template="ToastText02"><text id="1">${escapeXml(title.slice(0, 48))}</text><text id="2">${escapeXml(body.slice(0, 400))}</text></binding></visual></toast>`
}

function psScript(xmlB64: string, appId: string): string {
  return (
    `$x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlB64}'));` +
    `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null;` +
    `$d=[Windows.Data.Xml.Dom.XmlDocument]::new();$d.LoadXml($x);` +
    `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show([Windows.UI.Notifications.ToastNotification]::new($d))`
  )
}

export const windowsToastChannel: Channel = {
  id: "windows-toast",
  enabled: (cfg) => cfg.channels["windows-toast"].enabled,
  async send(n, ctx: SendCtx) {
    try {
      const conf = ctx.cfg.channels["windows-toast"]
      const b64 = Buffer.from(toastXml(n.title, n.body), "utf8").toString("base64")
      await runPowerShell(
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(b64, conf.appId || DEFAULT_APP_ID)],
        resolvePowerShellExe(conf.powershellPath || undefined),
        conf.timeoutMs,
        { spawnImpl: ctx.spawnImpl, log: ctx.log },
      )
      if (ctx.cfg.dryRun) ctx.log(`[dryrun] windows-toast xml=${toastXml(n.title, n.body)}`)
    } catch (e) {
      ctx.log(`windows-toast channel error: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
