const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

if (!NIM_API_KEY) {
  console.error('FATAL: NIM_API_KEY environment variable is not set');
  process.exit(1);
}

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = true;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'z-ai/glm4.7',
  'claude-3-sonnet': 'z-ai/glm5',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// ✅ 修正①: thinking対応モデルを明示的に定義
const THINKING_CAPABLE_MODELS = new Set([
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'qwen/qwen3-235b-a22b',
  'qwen/qwen3-next-80b-a3b-thinking',
  'qwen/qwen3-coder-480b-a35b-instruct',
  // 必要に応じて追加
]);

const verifiedModels = new Map();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "'messages' is required and must be a non-empty array",
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    // モデル解決（既存ロジック）
    let nimModel = MODEL_MAPPING[model];

    if (!nimModel) {
      if (verifiedModels.has(model)) {
        nimModel = verifiedModels.get(model);
      } else {
        try {
          const probeResponse = await axios.post(
            `${NIM_API_BASE}/chat/completions`,
            { model, messages: [{ role: 'user', content: 'test' }], max_tokens: 1 },
            {
              headers: {
                'Authorization': `Bearer ${NIM_API_KEY}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000,
              validateStatus: (s) => s < 500
            }
          );
          if (probeResponse.status >= 200 && probeResponse.status < 300) {
            nimModel = model;
            verifiedModels.set(model, model);
          } else {
            verifiedModels.set(model, null);
          }
        } catch (e) {
          console.warn('Model probe failed:', e.message);
          verifiedModels.set(model, null);
        }
      }

      if (!nimModel) {
        const ml = model.toLowerCase();
        if (ml.includes('gpt-4') || ml.includes('claude-opus') || ml.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (ml.includes('claude') || ml.includes('gemini') || ml.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }

    // ✅ 修正②: thinking対応モデルかどうか判定
    const useThinking = ENABLE_THINKING_MODE
      && THINKING_CAPABLE_MODELS.has(nimModel);

    console.log(`[PROXY] ${model} -> ${nimModel} | thinking: ${useThinking}`);

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.85,
      max_tokens: max_tokens || 16384,  // ✅ 修正③: 増量
      stream: stream || false,
      ...(useThinking && { chat_template_kwargs: { thinking: true } })
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 300000,  // ✅ 修正④: 5分に延長
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      // === ストリーミング処理 ===
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(rawLine => {
          const line = rawLine.replace(/\r$/, '');  // ✅ 修正⑤

          if (!line.startsWith('data:')) return;
          if (line.includes('[DONE]')) {
            if (SHOW_REASONING && reasoningStarted) {
              res.write(`data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: '</think>\n\n' } }]
              })}\n\n`);
              reasoningStarted = false;
            }
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const jsonStr = line.replace(/^data:\s*/, '');
            const data = JSON.parse(jsonStr);

            if (data.choices?.[0]?.delta) {
              const reasoning = data.choices[0].delta.reasoning_content;
              const content = data.choices[0].delta.content;

              if (SHOW_REASONING) {
                // ✅ 修正⑥: 閉じタグを別チャンクで送信
                if (reasoningStarted && !reasoning && content) {
                  res.write(`data: ${JSON.stringify({
                    id: data.id,
                    object: data.object,
                    choices: [{
                      index: 0,
                      delta: { content: '</think>\n\n' },
                      finish_reason: null
                    }]
                  })}\n\n`);
                  reasoningStarted = false;
                }

                let combinedContent = '';
                if (reasoning && !reasoningStarted) {
                  combinedContent = '<think>\n' + reasoning;
                  reasoningStarted = true;
                } else if (reasoning) {
                  combinedContent = reasoning;
                }
                if (content) {
                  combinedContent += content;
                }

                // ✅ 修正⑦: 常に明示的に設定
                data.choices[0].delta.content = combinedContent;
              } else {
                data.choices[0].delta.content = content || '';
              }

              delete data.choices[0].delta.reasoning_content;
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            console.warn('SSE parse error:', e.message);
          }
        });
      });

      response.data.on('end', () => {
        if (SHOW_REASONING && reasoningStarted) {
          res.write(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: '</think>\n\n' } }]
          })}\n\n`);
        }
        res.end();
      });

      response.data.on('error', (err) => {
        console.error('Stream error:', err.message);
        res.end();
      });

    } else {
      // === 非ストリーミング処理 ===

      // ✅ 修正⑧: デバッグログ（原因切り分け用）
      const rawContent = response.data.choices?.[0]?.message?.content;
      const rawReasoning = response.data.choices?.[0]?.message?.reasoning_content;
      console.log('[DEBUG] raw content has newlines:',
        rawContent ? rawContent.includes('\n') : 'null');
      console.log('[DEBUG] raw content sample:',
        rawContent ? JSON.stringify(rawContent.substring(0, 300)) : 'null');
      console.log('[DEBUG] reasoning_content exists:', !!rawReasoning);

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          const reasoning = choice.message?.reasoning_content || '';

          // ✅ 修正⑨: thinking非対応モデルが<think>を本文に混ぜた場合の処理
          if (!useThinking && !reasoning && content.includes('<think>')) {
            const thinkMatch = content.match(
              /^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/
            );
            if (thinkMatch) {
              const extractedReasoning = thinkMatch[1].trim();
              const extractedContent = thinkMatch[2].trim();
              if (SHOW_REASONING) {
                content = '<think>\n' + extractedReasoning
                  + '\n</think>\n\n' + extractedContent;
              } else {
                content = extractedContent;
              }
              return {
                index: choice.index,
                message: { role: choice.message.role, content },
                finish_reason: choice.finish_reason
              };
            }
          }

          // 通常のreasoning_content処理
          if (SHOW_REASONING && reasoning) {
            content = '<think>\n' + reasoning
              + '\n</think>\n\n' + content;
          }

          return {
            index: choice.index,
            message: { role: choice.message.role, content },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      res.json(openaiResponse);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'invalid_request_error',
          code: error.response?.status || 500
        }
      });
    } else {
      res.end();
    }
  }
});

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Reasoning: ${SHOW_REASONING} | Thinking: ${ENABLE_THINKING_MODE}`);
});
