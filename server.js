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
const providers = [];
let providerIndex = 1;

while (process.env[`PROVIDER_${providerIndex}_ENDPOINT`]) {
  providers.push({
    endpoint: process.env[`PROVIDER_${providerIndex}_ENDPOINT`],
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

// Model mapping: Maps requested model names to provider models
// Format: REQUESTED_MODEL=PROVIDER_INDEX
// Example: claude-opus-4-7=1 means requests for claude-opus-4-7 use provider 1's model
const modelMapping = {};
let modelMapIndex = 1;

while (process.env[`MODEL_MAP_${modelMapIndex}_REQUESTED`]) {
  const requested = process.env[`MODEL_MAP_${modelMapIndex}_REQUESTED`];
  const providerIndex = parseInt(process.env[`MODEL_MAP_${modelMapIndex}_PROVIDER`] || '1');
  modelMapping[requested] = providerIndex;
  modelMapIndex++;
}

console.log(`Loaded ${Object.keys(modelMapping).length} model mapping(s)`);

// Helper: Get provider index for requested model
function getProviderForModel(modelName) {
  if (modelMapping[modelName]) {
    return modelMapping[modelName];
  }
  // Default to first provider if no mapping found
  return 1;
}

// Helper: Get actual model name for requested model
function getActualModelName(requestedModel) {
  const providerIndex = getProviderForModel(requestedModel);
  const provider = providers[providerIndex - 1];
  return provider ? provider.model : requestedModel;
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper: Check if error is retryable
function isRetryableError(error, statusCode) {
  if (statusCode >= 500) return true;
  if (statusCode === 429) return true; // Rate limit
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
  return false;
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

// Helper: Transform response - keep actual model name from provider
function transformResponse(response) {
  // Don't transform model name - keep the actual model that was used
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
    transformed.messages.push({
      role: 'system',
      content: body.system,
    });
  }

  // Transform messages
  if (body.messages) {
    transformed.messages.push(...body.messages.map(msg => {
      // Handle content blocks (multimodal)
      if (Array.isArray(msg.content)) {
        return {
          role: msg.role,
          content: msg.content.map(block => {
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
          }),
        };
      }
      return msg;
    }));
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
    transformed.tools = body.tools;
  }

  // Handle tool_choice
  if (body.tool_choice) {
    transformed.tool_choice = body.tool_choice;
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

  // Handle start event
  if (choice.finish_reason === null && !delta.content && !delta.tool_calls) {
    return {
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
    };
  }

  // Handle content delta
  if (delta.content) {
    return {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text',
        text: delta.content,
      },
    };
  }

  // Handle content block start
  if (delta.content && choice.index === 0) {
    return {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    };
  }

  // Handle tool calls
  if (delta.tool_calls) {
    const toolCall = delta.tool_calls[0];
    if (toolCall.function) {
      return {
        type: 'content_block_delta',
        index: choice.index,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.function.arguments || '',
        },
      };
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
    return {
      type: 'message_stop',
      stop_reason: stopReasonMap[choice.finish_reason] || choice.finish_reason,
    };
  }

  return null;
}

// Main proxy endpoint
app.post('/v1/chat/completions', async (req, res) => {
  const originalModel = req.body.model || 'gpt-3.5-turbo';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`Attempt ${attempt}/${providers.length}: Using provider ${provider.endpoint} with model ${provider.model}`);

      const transformedBody = transformRequest(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(transformedBody),
      });

      const responseData = await response.json();

      if (!response.ok) {
        lastError = new Error(`Provider ${attempt} failed: ${(responseData.error && responseData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue; // Try next provider
        }
        // Non-retryable error - return immediately
        return res.status(response.status).json(responseData);
      }

      // Success - transform response and return
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

// Streaming support
app.post('/v1/chat/completions', async (req, res) => {
  if (!req.body.stream) {
    // Non-streaming handled above
    return;
  }

  const originalModel = req.body.model || 'gpt-3.5-turbo';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`Streaming attempt ${attempt}/${providers.length}: Using provider ${provider.endpoint}`);

      const transformedBody = transformRequest(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(transformedBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        lastError = new Error(`Provider ${attempt} failed: ${(errorData.error && errorData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue;
        }
        return res.status(response.status).json(errorData);
      }

      // Set up streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Pipe the stream, transforming model names
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
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
      }

      res.end();
      return;

    } catch (error) {
      lastError = error;
      console.error(`Provider ${attempt} error:`, error.message);
      continue;
    }
  }

  // All providers failed
  console.error('All providers failed for streaming');
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

// ==================== Anthropic API Endpoints ====================

// Anthropic messages endpoint (non-streaming)
app.post('/v1/messages', async (req, res) => {
  const originalModel = req.body.model || 'claude-3-opus-20240229';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`Anthropic attempt ${attempt}/${providers.length}: Using provider ${provider.endpoint}`);

      const transformedBody = anthropicToOpenai(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(transformedBody),
      });

      const responseData = await response.json();

      if (!response.ok) {
        lastError = new Error(`Provider ${attempt} failed: ${(responseData.error && responseData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue;
        }
        // Return Anthropic-style error
        return res.status(response.status).json({
          type: 'error',
          error: {
            type: (responseData.error && responseData.error.type) || 'api_error',
            message: (responseData.error && responseData.error.message) || response.statusText,
          },
        });
      }

      // Transform to Anthropic format
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

// Anthropic messages endpoint (streaming)
app.post('/v1/messages', async (req, res) => {
  if (!req.body.stream) {
    // Non-streaming handled above
    return;
  }

  const originalModel = req.body.model || 'claude-3-opus-20240229';
  let lastError = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const attempt = i + 1;

    try {
      console.log(`Anthropic streaming attempt ${attempt}/${providers.length}: Using provider ${provider.endpoint}`);

      const transformedBody = anthropicToOpenai(req.body, provider);
      const url = `${provider.endpoint}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(transformedBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        lastError = new Error(`Provider ${attempt} failed: ${(errorData.error && errorData.error.message) || response.statusText}`);
        console.error(`Provider ${attempt} error:`, lastError.message);

        if (isRetryableError(lastError, response.status)) {
          continue;
        }
        return res.status(response.status).json({
          type: 'error',
          error: {
            type: (errorData.error && errorData.error.type) || 'api_error',
            message: (errorData.error && errorData.error.message) || response.statusText,
          },
        });
      }

      // Set up streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let messageStarted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
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
              const anthropicEvent = openaiStreamChunkToAnthropic(parsed, originalModel);

              if (anthropicEvent) {
                const eventType = anthropicEvent.type;
                res.write(`event: ${eventType}\n`);
                res.write(`data: ${JSON.stringify(anthropicEvent)}\n\n`);
              }
            } catch (e) {
              // Skip unparseable chunks
            }
          }
        }
      }

      res.end();
      return;

    } catch (error) {
      lastError = error;
      console.error(`Provider ${attempt} error:`, error.message);
      continue;
    }
  }

  // All providers failed
  console.error('All providers failed for Anthropic streaming');
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
