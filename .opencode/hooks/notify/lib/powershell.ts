/**
 * Guarded powershell.exe spawn for WSL interop (design §1.3).
 * Cold start can take 1-2s (occasionally longer); the subprocess is killed at
 * timeoutMs so a hung Windows-side spawn can never stall the hook budget.
 */
import { existsSync } from "node:fs"

const DEFAULT_PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

export function resolvePowerShellExe(configured?: string): string {
  if (configured) return configured
  if (existsSync(DEFAULT_PS)) return DEFAULT_PS
  return "powershell.exe"
}

export interface PowerSpawnCtx {
  spawnImpl: typeof Bun.spawn
  log: (line: string) => void
}

export async function runPowerShell(args: string[], exe: string, timeoutMs: number, ctx: PowerSpawnCtx): Promise<void> {
  const proc = ctx.spawnImpl({ cmd: [exe, ...args], stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {}
  }, timeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "")
    ctx.log(`powershell exited ${code}: ${err.slice(0, 300)}`)
  }
}
