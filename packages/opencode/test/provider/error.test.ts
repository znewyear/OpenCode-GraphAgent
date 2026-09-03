import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { commandName } from "@/command-name"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })
})

describe("provider.error gateway", () => {
  test("401 HTML gateway response hint uses dynamic command name", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID: "anthropic" as never,
      error: new APICallError({
        message: "Unauthorized",
        url: "https://gateway.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        responseBody: "<!doctype html><html><body>Blocked</body></html>",
        isRetryable: false,
      }),
    })
    expect(parsed.type).toBe("api_error")
    expect(parsed.message).toContain(`\`${commandName()} auth login <your provider URL>\``)
    expect(parsed.message).not.toContain("opencode auth login")
  })
})
