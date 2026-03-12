const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ── Utility functions ───────────────────────────────────

function prepareMessages(messages) {
  return messages.map(msg => {
    let content = typeof msg.content === 'string' ? msg.content : '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { role: msg.role, content: content || '(continue)' };
  });
}

function enforceLineBreaks(text) {
  text = text.replace(/\r\n/g, '\n');

  if (text.length > 200 && !text.includes('\n\n')) {
    text = text.replace(/([.!?])\s+(")/g, '$1\n\n$2');
    text = text.replace(/([.!?""''"])\s+(\*)/g, '$1\n\n$2');
    text = text.replace(/(\*)\s+([A-Z"""])/g, '$1\n\n$2');
    text = text.replace(/(["""'])\s+([A-Z])/g, '$1\n\n$2');

    if (text.length > 400 && !text.includes('\n\n')) {
      let count = 0;
      text = text.replace(/([.!?])\s+([A-Z])/g, (match, p1, p2) => {
        count++;
        return count % 3 === 0 ? p1 + '\n\n' + p2 : match;
      });
    }
  }

  text = text.replace(/([^\n])\n(")/g, '$1\n\n$2');
  text = text.replace(/([^\n])\n(\*)/g, '$1\n\n$2');
  text = text.replace(/(["""'])\n([A-Z*])/g, '$1\n\n$2');
  text = text.replace(/([.!?""'*])\s+([-—]{2,})/g, '$1\n\n$2');
  text = text.replace(/([.!?""'*])\s+(\[)/g, '$1\n\n$2');
  text = text.replace(/(\])\s+([A-Z"*])/g, '$1\n\n$2');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text;
}

function processContent(content) {
  let thinkBlock = '';
  let body = content;

  const thinkMatch = content.match(/^\s*(<think>[\s\S]*?<\/think>)\s*([\s\S]*)$/);
  if (thinkMatch) {
    thinkBlock = thinkMatch[1];
    body = thinkMatch[2];
  }

  body = enforceLineBreaks(body);
  return thinkBlock ? thinkBlock + '\n\n' + body : body;
}

// ── Fetch from NIM using streaming to prevent timeout ───

async function fetchFromNIM(preparedMessages, temperature, max_tokens) {
  // Try streaming first (keeps connection alive)
  try {
    return await streamFromNIM(preparedMessages, temperature, max_tokens);
  } catch (err) {
    console.log(`    Stream mode failed (${err.message}), trying non-stream...`);
    return await nonStreamFromNIM(preparedMessages, temperature, max_tokens);
  }
}

async function streamFromNIM(preparedMessages, temperature, max_tokens) {
  const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
    model: 'z-ai/glm5',
    messages: preparedMessages,
    temperature: temperature || 0.85,
    max_tokens: max_tokens || 9024,
    stream: true,
    chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
  }, {
    headers: {
      'Authorization': `Bearer ${NIM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream',
    timeout: 300000
  });

  return new Promise((resolve, reject) => {
    let fullContent = '';
    let finishReason = 'stop';
    let usage = null;
    let buf = '';

    response.data.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices?.[0]?.delta?.content) {
            fullContent += parsed.choices[0].delta.content;
          }
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason;
          }
          if (parsed.usage) usage = parsed.usage;
        } catch (e) {}
      }
    });

    response.data.on('end', () => resolve({ fullContent, finishReason, usage }));
    response.data.on('error', reject);
  });
}

async function nonStreamFromNIM(preparedMessages, temperature, max_tokens) {
  const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
    model: 'z-ai/glm5',
    messages: preparedMessages,
    temperature: temperature || 0.85,
    max_tokens: max_tokens || 9024,
    stream: false,
    chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
  }, {
    headers: {
      'Authorization': `Bearer ${NIM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 300000
  });

  const choice = response.data.choices?.[0];
  return {
    fullContent: choice?.message?.content || '',
    finishReason: choice?.finish_reason || 'stop',
    usage: response.data.usage || null
  };
}

// ── Routes ──────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'claude-3-sonnet',
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  const { model, messages, temperature, max_tokens } = req.body;
  const preparedMessages = prepareMessages(messages);
  const wantsStream = req.body.stream === true;

  console.log('\n── Turn ──');
  console.log(`  Messages: ${messages.length} | Client wants stream: ${wantsStream}`);
  const startTime = Date.now();

  if (wantsStream) {
    // ── STREAMING: SSE with heartbeats — fully timeout-proof ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`  Attempt ${attempt}...`);
        const { fullContent, finishReason } = await fetchFromNIM(
          preparedMessages, temperature, max_tokens
        );

        clearInterval(heartbeat);
        console.log(`  Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

        const finalContent = processContent(fullContent);
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const mdl = model || 'claude-3-sonnet';

        console.log(`  [output] len=${finalContent.length} think=${finalContent.startsWith('<think>')}`);

        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        })}\n\n`);

        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }]
        })}\n\n`);

        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
        })}\n\n`);

        res.write('data: [DONE]\n\n');
        res.end();
        return;

      } catch (err) {
        lastError = err;
        console.log(`  Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 5000));
      }
    }

    clearInterval(heartbeat);
    console.error('  FAILED after all retries');
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model || 'claude-3-sonnet',
      choices: [{ index: 0, delta: { role: 'assistant', content: '[Error: API failed after retries. Try again.]' }, finish_reason: 'stop' }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } else {
    // ── NON-STREAMING: JSON response (still streams from NIM internally) ──
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`  Attempt ${attempt}...`);
        const { fullContent, finishReason, usage } = await fetchFromNIM(
          preparedMessages, temperature, max_tokens
        );

        console.log(`  Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        const finalContent = processContent(fullContent);

        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || 'claude-3-sonnet',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: finishReason
          }],
          usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
        return;

      } catch (err) {
        lastError = err;
        console.log(`  Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 5000));
      }
    }

    console.error('  FAILED after all retries');
    res.status(lastError?.response?.status || 500).json({
      error: {
        message: lastError?.message || 'Internal server error',
        type: 'invalid_request_error',
        code: lastError?.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
