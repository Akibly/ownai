# Use OwnAI from Compii

OwnAI is an OpenAI-compatible backend for Compii. Compii sends its tool definitions to OwnAI; OwnAI forwards them to the selected API connection and returns the model's tool calls so Compii can run its tools. The gateway does not run Compii's tools itself.

## Set it up

1. In the regular OwnAI console, use **Connect a free AI account** to choose a free provider plan, set its model and alias, then paste the API key you created with that provider. OwnAI stores the key in Windows Credential Manager. You can also add it from PowerShell, for example:

   ```powershell
   pnpm bridge providers
   pnpm bridge add-api groq --alias compii-brain
   ```

   Enter the **Groq API key** when prompted. OwnAI puts it in Windows Credential Manager. Choose an upstream model that supports function calling; use `pnpm bridge models` to see the configured model and available aliases. Built-in API providers declare tool support in their presets. If Ollama is running locally, choose its local provider and use an installed model instead of entering a provider API key.

2. Start OwnAI and keep it running:

   ```powershell
   pnpm bridge start
   ```

   Use the address printed by `pnpm bridge start`, followed by `/v1`. The standard port is `8791`; if configured with another port, use that port in Compii too. A preview instance may use a temporary key and in-memory connections, so use the regular bridge process for a durable setup.

3. In Compii, open **Settings → Brain** and choose **OwnAI gateway**. Enter the same server address printed by OwnAI and the connection alias you added:

   - **Server address:** `http://127.0.0.1:<bridge-port>/v1` (replace `<bridge-port>` with the port printed by the bridge)
   - **Model:** `compii-brain` (the OwnAI alias you added; use your chosen alias if different)
   - **API key:** your **OwnAI gateway key**, not the Groq key

   Retrieve the OwnAI key with `pnpm bridge key`. Save it in Compii's API key field, then save the Brain settings. Compii stores this key in Windows Credential Manager. Use Compii's test button: its probe asks the selected model to call a small test tool, which checks more than a simple text reply.

The two keys have different jobs: the provider key goes into OwnAI when you add the provider connection; the OwnAI gateway key goes into Compii. Neither should be pasted into the other's field.

## What works, and what depends on the model

OwnAI's built-in API connections pass through function tool definitions, tool-choice settings, assistant tool calls, and tool results. They support multi-turn messages, system instructions, native streaming, and the sampling parameters declared by their provider preset. Compii can therefore run its tools when both the selected OwnAI API connection and its specific model support tool calling. Compii's own capability probe reports whether the model actually used the offered test tool.

Fresh OwnAI installs do not add a mock model. The mock remains available only as an explicit development/test connection. Browser connections do not implement model-generated tool calls. A custom OpenAI-compatible connection also starts with tools disabled. Only enable a capability after checking the custom server's documentation. For example:

```powershell
pnpm bridge add-api custom `
  --base-url http://127.0.0.1:9000/v1 `
  --model your-model `
  --alias compii-brain `
  --consumption local_compute `
  --supports-tools `
  --native-streaming `
  --sampling-params temperature,top_p,max_tokens,stop
```

The `--supports-tools` and `--native-streaming` flags describe the server you configured; use them only if that server and model support those features. Omit `--native-streaming` if it only supports ordinary JSON replies. Add `--json-mode` only when the server supports OpenAI `response_format`. Custom capabilities are opt-ins; built-in provider claims stay tied to their presets.

If you already added this custom connection without tool support, remove that connection by its OwnAI connection ID (`pnpm bridge list`, then `pnpm bridge remove <connection-id>`) and add it again with the capability flags. Adding an API connection never changes or replaces the Compii Brain selection automatically.

Vision/image input is not currently supported by OwnAI's text adapter. JSON mode is disabled by default. Unsupported features are refused with an error instead of silently dropped. Provider limits, model-specific tool support, and billing remain controlled by the upstream provider.

## If Compii's test fails

- **401 / invalid key:** paste the OwnAI gateway key from `pnpm bridge key` into Compii, then save it.
- **404 / model not found:** use the OwnAI alias, not the upstream provider's raw model ID. Check it with `pnpm bridge models`.
- **Tool probe says the model did not use tools:** select a model with function-calling support. A successful ordinary chat response alone does not prove tool support.
- **Unsupported feature:** check OwnAI's connection capabilities. Browser and mock connections cannot be made into tool-calling models by changing Compii settings.
- **Connection refused:** keep `pnpm bridge start` running and confirm Compii points to `127.0.0.1` on OwnAI's actual port.
