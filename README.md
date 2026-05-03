# AI Proxi - OpenAI & Anthropic Compatible Proxy with Automated Fallback

A dual-API proxy server that automatically falls back to alternative LLM providers when the primary provider fails. Supports both OpenAI and Anthropic API formats, multimodal requests (text, images, audio), and streaming responses.

## Features

- **Dual API Support**: OpenAI-compatible (`/v1/chat/completions`) and Anthropic-compatible (`/v1/messages`) endpoints
- **Automated Fallback**: Tries providers in order until one succeeds
- **Multimodal Support**: Handles text, images, audio, and other content types
- **Streaming Support**: Full SSE streaming support for real-time responses
- **Format Translation**: Automatically translates between OpenAI and Anthropic request/response formats
- **Multiple Providers**: Configure any number of fallback providers

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure your providers:

```bash
cp .env.example .env
```

Edit `.env` with your provider details:

```env
PORT=3000

# Provider 1 (Primary)
PROVIDER_1_ENDPOINT=https://api.openai.com
PROVIDER_1_API_KEY=sk-your-openai-api-key
PROVIDER_1_MODEL=gpt-4-turbo

# Provider 2 (Fallback)
PROVIDER_2_ENDPOINT=https://api.anthropic.com
PROVIDER_2_API_KEY=sk-ant-your-anthropic-api-key
PROVIDER_2_MODEL=claude-3-opus-20240229

# Provider 3 (Fallback)
PROVIDER_3_ENDPOINT=https://api.mistral.ai
PROVIDER_3_API_KEY=your-mistral-api-key
PROVIDER_3_MODEL=mistral-large
```

## Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## Usage

### OpenAI API Format

Use with any OpenAI-compatible client:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "any-key", // Not used by proxy, but required by client
});

// Text completion
const response = await client.chat.completions.create({
  model: "gpt-4-turbo",
  messages: [{ role: "user", content: "Hello!" }],
});

// Multimodal (image analysis)
const response = await client.chat.completions.create({
  model: "gpt-4-vision-preview",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What do you see?" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/image.jpg" },
        },
      ],
    },
  ],
});

// Streaming
const stream = await client.chat.completions.create({
  model: "gpt-4-turbo",
  messages: [{ role: "user", content: "Tell me a story" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### Anthropic API Format

Use with the Anthropic SDK:

```javascript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3000",
  apiKey: "any-key", // Not used by proxy, but required by client
});

// Text completion
const response = await client.messages.create({
  model: "claude-3-opus-20240229",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.content[0].text);

// With system prompt
const response = await client.messages.create({
  model: "claude-3-opus-20240229",
  max_tokens: 1024,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }],
});

// Multimodal (image analysis)
const response = await client.messages.create({
  model: "claude-3-opus-20240229",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What do you see?" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "base64-encoded-image-data",
          },
        },
      ],
    },
  ],
});

// Streaming
const stream = await client.messages.create({
  model: "claude-3-opus-20240229",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Tell me a story" }],
  stream: true,
});

for await (const event of stream) {
  if (event.type === "content_block_delta") {
    process.stdout.write(event.delta.text);
  }
}
```

## cURL Examples

### OpenAI Format

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Anthropic Format

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any-key" \
  -d '{
    "model": "claude-3-opus-20240229",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Health Check

```bash
curl http://localhost:3000/health
```

## Supported Providers

Any OpenAI-compatible API endpoint, including:

- OpenAI
- Anthropic (via OpenAI-compatible endpoints)
- Mistral AI
- Together AI
- Groq
- Local LLMs (Ollama, vLLM, etc.)
- Custom deployments

## API Endpoints

| Format    | Endpoint                    | Description                                  |
| --------- | --------------------------- | -------------------------------------------- |
| OpenAI    | `POST /v1/chat/completions` | Chat completions (non-streaming & streaming) |
| Anthropic | `POST /v1/messages`         | Messages API (non-streaming & streaming)     |
| Health    | `GET /health`               | Server health and provider status            |

## Fallback Behavior

The proxy will:

1. Try Provider 1 first
2. On error (5xx, 429, timeout), try Provider 2
3. Continue until a provider succeeds or all fail
4. Return the first successful response
5. Transform model names back to the original requested model

## License

SPL-R5
