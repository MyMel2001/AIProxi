import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure fallback providers from environment variables
// Format: PROVIDER_1_ENDPOINT, PROVIDER_1_API_KEY, PROVIDER_1_MODEL
//         PROVIDER_2_ENDPOINT, PROVIDER_2_API_KEY, PROVIDER_2_MODEL
//         ...
// Helper: Normalize endpoint URL by stripping trailing slash and /v1 suffix
// This prevents double /v1 paths when constructing upstream URLs
function normalizeEndpoint(url) {
  let normalized = url.replace(/\/+$/, ''); // strip trailing slashes
  // Strip trailing /v1 (case-insensitive) so we can always prepend it ourselves
  normalized = normalized.replace(/\/v1$/i, '');
  return normalized;
}

const providers = [];
let providerIndex = 1;

while (process.env[`PROVIDER_${providerIndex}_ENDPOINT`]) {
  const rawEndpoint = process.env[`PROVIDER_${providerIndex}_ENDPOINT`];
  providers.push({
    endpoint: normalizeEndpoint(rawEndpoint),
    apiKey: process.env[`PROVIDER_${providerIndex}_API_KEY`],
    model: process.env[`PROVIDER_${providerIndex}_MODEL`] || 'gpt-3.5-turbo',
  });
  providerIndex++;
}

if (providers.length === 0) {
  console.error('No providers configured. Please set PROVIDER_1_ENDPOINT, PROVIDER_1_API_KEY, and PROVIDER_1_MODEL');
  process.exit(1);
}

console.log(`Loaded ${providers.length} provider(s) for fallback`);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper: Check if error is retryable
// For a fallback proxy, most provider errors should trigger fallback since each
// provider has its own credentials, model, and endpoint. Only truly client-side
// errors (malformed request body) should stop immediately.
function isRetryableError(error, statusCode) {
  // 400 = bad request body — will fail on every provider, stop immediately
  if (statusCode === 400) return false;
  // Everything else (401, 403, 404, 429, 500+, network errors) is provider-specific
  return true;
}

// Helper: Transform request for multimodal support
function transformRequest(body, provider) {
  const transformed = { ...body };

  // Override model with provider's model
  if (provider.model) {
    transformed.model = provider.model;
  }

  // Handle multimodal content (images, audio, etc.)
  if (transformed.messages) {
    transformed.messages = transformed.messages.map(msg => {
      if (Array.isArray(msg.content)) {
        // Multimodal content - preserve as-is for providers that support it
        return msg;
      }
      return msg;
    });
  }

  return transformed;
}

// Helper: Transform response back to original model name
function transformResponse(response, originalModel) {
  if (response.choices && response.choices.length > 0) {
    response.choices.forEach(choice => {
      if (choice.model) {
        choice.model = originalModel;
      }
    });
  }
  if (response.model) {
    response.model = originalModel;
  }
  return response;
}

// Helper: Transform Anthropic request to OpenAI format
function anthropicToOpenai(body, provider) {
  const transformed = {
    model: provider.model,
    messages: [],
  };

  // Handle system prompt
  if (body.system) {
    let systemContent = body.system;
    if (Array.isArray(body.system)) {
      systemContent = body.system.map(b => b.text).join('\n');
    }
    transformed.messages.push({
      role: 'system',
      content: systemContent,
    });
  }

  // Transform messages
  if (body.messages) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        transformed.messages.push(msg);
      } else if (Array.isArray(msg.content)) {
        if (msg.role === 'assistant') {
          const textBlocks = msg.content.filter(b => b.type === 'text');
          const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
          
          const newMsg = { role: 'assistant', content: null };
          if (textBlocks.length > 0) {
            newMsg.content = textBlocks.map(b => b.text).join('\n');
          }
          
          if (toolUseBlocks.length > 0) {
            newMsg.tool_calls = toolUseBlocks.map(b => ({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input)
              }
            }));
          }
          
          transformed.messages.push(newMsg);
        } else if (msg.role === 'user') {
          const normalBlocks = msg.content.filter(b => b.type === 'text' || b.type === 'image');
          const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');
          
          for (const block of toolResultBlocks) {
            let contentStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            transformed.messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: contentStr || "Success"
            });
          }
          
          if (normalBlocks.length > 0) {
            transformed.messages.push({
              role: 'user',
              content: normalBlocks.map(block => {
                if (block.type === 'image') {
                  return {
                    type: 'image_url',
                    image_url: { url: (block.source && block.source.data) || (block.source && block.source.url) },
                  };
                }
                if (block.type === 'text') {
                  return { type: 'text', text: block.text };
                }
                return block;
              })
            });
          }
        } else {
          transformed.messages.push(msg);
        }
      } else {
        transformed.messages.push(msg);
      }
    }
  }

  // Handle max_tokens
  if (body.max_tokens !== undefined) {
    transformed.max_tokens = body.max_tokens;
  }

  // Handle temperature
  if (body.temperature !== undefined) {
    transformed.temperature = body.temperature;
  }

  // Handle top_p
  if (body.top_p !== undefined) {
    transformed.top_p = body.top_p;
  }

  // Handle stop_sequences
  if (body.stop_sequences) {
    transformed.stop = body.stop_sequences;
  }

  // Handle tools
  if (body.tools) {
    transformed.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));
  }

  // Handle tool_choice
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') {
      transformed.tool_choice = 'auto';
    } else if (body.tool_choice.type === 'any') {
      transformed.tool_choice = 'required';
    } else if (body.tool_choice.type === 'tool') {
      transformed.tool_choice = {
        type: 'function',
        function: { name: body.tool_choice.name }
      };
    }
  }

  return transformed;
}

// Helper: Transform OpenAI response to Anthropic format
function openaiToAnthropic(response, originalModel) {
  const anthropicResponse = {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [],
    model: originalModel,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: response.usage,
  };

  // Transform content
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];

    // Handle finish_reason -> stop_reason
    if (choice.finish_reason) {
      const stopReasonMap = {
        'stop': 'end_turn',
        'length': 'max_tokens',
        'tool_calls': 'tool_use',
        'content_filter': 'stop_sequence',
      };
      anthropicResponse.stop_reason = stopReasonMap[choice.finish_reason] || choice.finish_reason;
    }

    // Handle message content
    if (choice.message) {
      if (choice.message.content) {
        if (typeof choice.message.content === 'string') {
          anthropicResponse.content.push({
            type: 'text',
            text: choice.message.content,
          });
        } else if (Array.isArray(choice.message.content)) {
          anthropicResponse.content = choice.message.content.map(block => {
            if (block.type === 'image_url') {
              return {
                type: 'image',
                source: { url: block.image_url && block.image_url.url },
              };
            }
            return block;
          });
        }
      }

      // Handle tool_calls
      if (choice.message.tool_calls) {
        anthropicResponse.content.push(...choice.message.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })));
      }
    }
  }

  return anthropicResponse;
}

// Helper: Transform OpenAI streaming chunk to Anthropic format
function openaiStreamChunkToAnthropic(chunk, originalModel) {
  if (!chunk.choices || chunk.choices.length === 0) {
    return null;
  }

  const choice = chunk.choices[0];
  const delta = choice.delta;
  const events = [];

  // Handle start event
  if (choice.finish_reason === null && delta.role === 'assistant') {
    events.push({
      type: 'message_start',
      message: {
        id: chunk.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: chunk.usage,
      },
    });

    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    });
  }

  // Handle content delta
  if (delta.content !== undefined && delta.content !== null) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text',
        text: delta.content,
      },
    });
  }

  // Handle tool calls
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const toolIndex = (toolCall.index || 0) + 1; // Assuming text is at index 0
      
      if (toolCall.id) {
        events.push({
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {}
          }
        });
      }
      
      if (toolCall.function && toolCall.function.arguments) {
        events.push({
          type: 'content_block_delta',
          index: toolIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: toolCall.function.arguments,
          }
        });
      }
    }
  }

  // Handle message stop
  if (choice.finish_reason) {
    const stopReasonMap = {
      'stop': 'end_turn',
      'length': 'max_tokens',
      'tool_calls': 'tool_use',
      'content_filter': 'stop_sequence',
    };
    events.push({
      type: 'message_stop',
      stop_reason: stopReasonMap[choice.finish_reason] || choice.finish_reason,
    });
  }

  return events.length > 0 ? events : null;
}

// Main proxy endpoint (handle both /v1/chat/completions and /chat/completions
// so clients with base URL ending in /v1 don't get double-prefixed)
app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  const isStreaming = !!req.body.stream;
  const originalModel = req.body.model || 'gpt-3.5-turbo';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`${isStreaming ? 'Streaming a' : 'A'}ttempt ${attempt}/${providers.length}: Using provider ${provider.endpoint} with model ${provider.model}`);

      const transformedBody = transformRequest(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const headers = { 'Content-Type': 'application/json' };
      if (provider.apiKey && provider.apiKey.length > 1) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(transformedBody),
      });

      if (!response.ok) {
        let errorData;
        try { errorData = await response.json(); } catch (_) { errorData = {}; }
        lastError = new Error(`Provider ${attempt} failed (${response.status}): ${(errorData.error && errorData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue; // Try next provider
        }
        // Non-retryable error (e.g. 400 bad request) - return immediately
        return res.status(response.status).json(errorData);
      }

      // === Streaming response ===
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        await new Promise((resolve, reject) => {
          response.body.on('data', (buf) => {
            const chunk = buf.toString();
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  res.write('data: [DONE]\n\n');
                  continue;
                }

                try {
                  const parsed = JSON.parse(data);
                  const transformed = transformResponse(parsed, originalModel);
                  res.write(`data: ${JSON.stringify(transformed)}\n\n`);
                } catch (e) {
                  res.write(line + '\n');
                }
              } else if (line.trim()) {
                res.write(line + '\n');
              }
            }
          });
          response.body.on('end', resolve);
          response.body.on('error', reject);
        });

        res.end();
        return;
      }

      // === Non-streaming response ===
      const responseData = await response.json();
      const finalResponse = transformResponse(responseData, originalModel);
      return res.json(finalResponse);

    } catch (error) {
      lastError = error;
      console.error(`Provider ${attempt} error:`, error.message);
      continue;
    }
  }

  // All providers failed
  console.error('All providers failed');
  return res.status(500).json({
    error: {
      message: (lastError && lastError.message) || 'All providers failed',
      type: 'api_error',
      code: 'all_providers_failed',
    },
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    providers: providers.length,
    providers_configured: providers.map((p, i) => ({
      index: i + 1,
      endpoint: p.endpoint,
      model: p.model,
      has_api_key: !!p.apiKey,
    })),
  });
});

// Models endpoints (handle both /v1/models and /models)
app.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'proxy_fallback',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'system',
        type: 'model',
        display_name: 'Proxy Fallback'
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'system',
        type: 'model',
        display_name: 'Claude 3.5 Sonnet'
      },
      {
        id: 'claude-3-7-sonnet-20250219',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'system',
        type: 'model',
        display_name: 'Claude 3.7 Sonnet'
      }
    ]
  });
});

app.get(['/v1/models/:modelId', '/models/:modelId'], (req, res) => {
  res.json({
    id: req.params.modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'system',
    type: 'model',
    display_name: req.params.modelId
  });
});

// ==================== Anthropic API Endpoints ====================

// Anthropic messages endpoint (streaming + non-streaming)
// Handle both /v1/messages and /messages for clients that include /v1 in base URL
app.post(['/v1/messages', '/messages'], async (req, res) => {
  const isStreaming = !!req.body.stream;
  const originalModel = req.body.model || 'claude-3-opus-20240229';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`Anthropic ${isStreaming ? 'streaming ' : ''}attempt ${attempt}/${providers.length}: Using provider ${provider.endpoint}`);

      const transformedBody = anthropicToOpenai(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const headers = { 'Content-Type': 'application/json' };
      if (provider.apiKey && provider.apiKey.length > 1) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(transformedBody),
      });

      if (!response.ok) {
        let errorData;
        try { errorData = await response.json(); } catch (_) { errorData = {}; }
        lastError = new Error(`Provider ${attempt} failed (${response.status}): ${(errorData.error && errorData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue; // Try next provider
        }
        // Non-retryable error - return Anthropic-style error immediately
        return res.status(response.status).json({
          type: 'error',
          error: {
            type: (errorData.error && errorData.error.type) || 'api_error',
            message: (errorData.error && errorData.error.message) || response.statusText,
          },
        });
      }

      // === Streaming response ===
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        await new Promise((resolve, reject) => {
          response.body.on('data', (buf) => {
            const chunk = buf.toString();
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  res.write('event: message_stop\n');
                  res.write('data: {"type":"message_stop","stop_reason":"end_turn"}\n\n');
                  continue;
                }

                try {
                  const parsed = JSON.parse(data);
                  const anthropicEvents = openaiStreamChunkToAnthropic(parsed, originalModel);

                  if (anthropicEvents) {
                    const events = Array.isArray(anthropicEvents) ? anthropicEvents : [anthropicEvents];
                    for (const ev of events) {
                      const eventType = ev.type;
                      res.write(`event: ${eventType}\n`);
                      res.write(`data: ${JSON.stringify(ev)}\n\n`);
                    }
                  }
                } catch (e) {
                  // Skip unparseable chunks
                }
              }
            }
          });
          response.body.on('end', resolve);
          response.body.on('error', reject);
        });

        res.end();
        return;
      }

      // === Non-streaming response ===
      const responseData = await response.json();
      const finalResponse = openaiToAnthropic(responseData, originalModel);
      return res.json(finalResponse);

    } catch (error) {
      lastError = error;
      console.error(`Provider ${attempt} error:`, error.message);
      continue;
    }
  }

  // All providers failed
  console.error('All providers failed for Anthropic request');
  return res.status(500).json({
    type: 'error',
    error: {
      type: 'api_error',
      message: (lastError && lastError.message) || 'All providers failed',
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`AI Proxi server running on port ${PORT}`);
  console.log(`Configured with ${providers.length} fallback provider(s)`);
  console.log(`OpenAI endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`Anthropic endpoint: http://localhost:${PORT}/v1/messages`);
});
