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

// ── Fetch from NIM (tries stream, falls back to non-stream) ──

async function fetchFromNIM(preparedMessages, temperature, max_tokens) {
  const payload = {
    model: 'z-ai/glm5',
    messages: preparedMessages,
    temperature: temperature || 0.85,
    max_tokens: max_tokens || 9024,
    chat_template_kwargs: { enable_thinking: true, clear_thinking: false }
  };

  const headers = {
    'Authorization': `Bearer ${NIM_API_KEY}`,
    'Content-Type': 'application/json'
  };

  // Try streaming first (keeps connection alive during long generation)
  try {
    console.log('    NIM: trying stream...');
    const resp = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      { ...payload, stream: true },
      { headers, responseType: 'stream', timeout: 300000 }
    );

    return await new Promise((resolve, reject) => {
      let fullContent = '';
      let finishReason = 'stop';
      let buf = '';
      let chunks = 0;

      resp.data.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const d = trimmed.slice(6).trim();
          if (d === '[DONE]') continue;
          try {
            const p = JSON.parse(d);
            if (p.choices?.[0]?.delta?.content) {
              fullContent += p.choices[0].delta.content;
              chunks++;
            }
            if (p.choices?.[0]?.finish_reason) {
              finishReason = p.choices[0].finish_reason;
            }
          } catch (e) {}
        }
      });

      resp.data.on('end', () => {
        console.log(`    NIM stream done: ${chunks} chunks, ${fullContent.length} chars`);
        resolve({ content: fullContent, finishReason });
      });

      resp.data.on('error', (err) => {
        if (fullContent.length > 0) {
          console.log(`    NIM stream error mid-response, using partial (${fullContent.length} chars)`);
          resolve({ content: fullContent, finishReason: 'stop' });
        } else {
          reject(err);
        }
      });
    });
  } catch (streamErr) {
    console.log(`    NIM stream failed: ${streamErr.message}`);
  }

  // Fallback: non-streaming
  console.log('    NIM: trying non-stream...');
  const resp = await axios.post(
    `${NIM_API_BASE}/chat/completions`,
    { ...payload, stream: false },
    { headers, timeout: 300000 }
  );
  const c = resp.data.choices?.[0];
  console.log(`    NIM non-stream done: ${(c?.message?.content || '').length} chars`);
  return {
    content: c?.message?.content || '',
    finishReason: c?.finish_reason || 'stop'
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

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const mdl = model || 'claude-3-sonnet';
  const startTime = Date.now();

  console.log(`\n── Turn | ${wantsStream ? 'STREAM' : 'JSON'} | ${messages.length} msgs ──`);

  // Detect client disconnect
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    console.log('  Client disconnected');
  });

  if (wantsStream) {
    // ══════════════════════════════════════
    // STREAMING RESPONSE TO CLIENT
    // ══════════════════════════════════════

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send role chunk immediately so connection is established
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: mdl,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    })}\n\n`);

    // Keepalive: send empty content deltas every 15s
    let finished = false;
    const keepalive = setInterval(() => {
      if (finished || clientDisconnected) return;
      try {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: { content: '' }, finish_reason: null }]
        })}\n\n`);
      } catch (e) {}
    }, 15000);

    const sendContent = (content, fReason) => {
      finished = true;
      clearInterval(keepalive);
      if (clientDisconnected) return;

      const finalContent = processContent(content);

      // Send in small chunks so JanitorAI can process incrementally
      const pieces = finalContent.match(/.{1,80}/gs) || [finalContent];
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
        })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: mdl,
        choices: [{ index: 0, delta: {}, finish_reason: fReason }]
      })}\n\n`);

      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`  ✓ Sent ${finalContent.length} chars in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    };

    const sendError = (msg) => {
      finished = true;
      clearInterval(keepalive);
      if (clientDisconnected) return;

      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: mdl,
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${msg}]` }, finish_reason: 'stop' }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`  ✗ Error sent: ${msg}`);
    };

    // Retry loop
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (clientDisconnected) break;
      try {
        console.log(`  Attempt ${attempt}...`);
        const result = await fetchFromNIM(preparedMessages, temperature, max_tokens);
        sendContent(result.content, result.finishReason);
        return;
      } catch (err) {
        lastErr = err;
        console.log(`  Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3 && !clientDisconnected) {
          await new Promise(r => setTimeout(r, attempt * 5000));
        }
      }
    }
    sendError(lastErr?.message || 'All attempts failed');

  } else {
    // ══════════════════════════════════════
    // NON-STREAMING RESPONSE TO CLIENT
    // ══════════════════════════════════════

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (clientDisconnected) break;
      try {
        console.log(`  Attempt ${attempt}...`);
        const result = await fetchFromNIM(preparedMessages, temperature, max_tokens);
        const finalContent = processContent(result.content);
        console.log(`  ✓ ${finalContent.length} chars in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

        return res.json({
          id, object: 'chat.completion', created, model: mdl,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: result.finishReason
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      } catch (err) {
        lastErr = err;
        console.log(`  Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3 && !clientDisconnected) {
          await new Promise(r => setTimeout(r, attempt * 5000));
        }
      }
    }

    console.error(`  ✗ All attempts failed`);
    res.status(lastErr?.response?.status || 500).json({
      error: {
        message: lastErr?.message || 'Internal server error',
        type: 'invalid_request_error',
        code: lastErr?.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
