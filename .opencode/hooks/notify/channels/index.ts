import { registerChannel } from "./registry"
import { windowsToastChannel } from "./windows-toast"
import { dingtalkChannel } from "./dingtalk"
import { feishuChannel } from "./feishu"

export function registerBuiltinChannels(): void {
  registerChannel(windowsToastChannel)
  registerChannel(dingtalkChannel)
  registerChannel(feishuChannel)
}

export { windowsToastChannel, dingtalkChannel, feishuChannel }
