const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// How many conversation messages to keep (not counting system).
// Lower = faster NIM responses. 20 ≈ 10 back-and-forth turns.
// Adjust via environment variable if needed.
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY) || 20;

// ── Prepare messages: trim context + strip think blocks ──

function prepareMessages(messages) {
  const system = messages.filter(m => m.role === 'system');
  const conversation = messages.filter(m => m.role !== 'system');
  const recent = conversation.slice(-MAX_HISTORY);
  const trimmed = conversation.length - recent.length;

  if (trimmed > 0) {
    console.log(`  Context trimmed: dropped ${trimmed} oldest messages (keeping ${recent.length})`);
  }

  return [...system, ...recent].map(msg => {
    let content = typeof msg.content === 'string' ? msg.content : '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { role: msg.role, content: content || '(continue)' };
  });
}

// ── Enforce linebreaks on model output ──────────────────

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

// ── Process model output: extract think + enforce formatting ──

function processChoice(choice) {
  let content = choice.message?.content || '';
  let thinkBlock = '';
  let body = content;

  const thinkMatch = content.match(/^\s*(<think>[\s\S]*?<\/think>)\s*([\s\S]*)$/);
  if (thinkMatch) {
    thinkBlock = thinkMatch[1];
    body = thinkMatch[2];
  }

  if (!thinkBlock && choice.message?.reasoning_content) {
    thinkBlock = '<think>\n' + choice.message.reasoning_content + '\n</think>';
  }

  body = enforceLineBreaks(body);
  return thinkBlock ? thinkBlock + '\n\n' + body : body;
}

// ── Routes ──────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
  const wantsStream = req.body.stream === true;
  const mdl = model || 'claude-3-sonnet';
  const startTime = Date.now();

  console.log(`\n── Turn | ${wantsStream ? 'STREAM' : 'JSON'} | ${messages.length} msgs ──`);
  const preparedMessages = prepareMessages(messages);
  console.log(`  Sending ${preparedMessages.length} messages to NIM...`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  Attempt ${attempt}...`);

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

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ✓ NIM responded in ${elapsed}s`);

      const choice = response.data.choices?.[0];
      if (!choice) throw new Error('NIM returned no choices');

      const finalContent = processChoice(choice);
      console.log(`  [output] len=${finalContent.length} think=${finalContent.includes('<think>')}`);

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        })}\n\n`);

        const CHUNK_SIZE = 80;
        for (let i = 0; i < finalContent.length; i += CHUNK_SIZE) {
          const piece = finalContent.substring(i, i + CHUNK_SIZE);
          res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: mdl,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
          })}\n\n`);
        }

        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: mdl,
          choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }]
        })}\n\n`);

        res.write('data: [DONE]\n\n');
        return res.end();
      } else {
        return res.json({
          id, object: 'chat.completion', created, model: mdl,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: choice.finish_reason || 'stop'
          }],
          usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }

    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const errData = err.response?.data;
      console.log(`  ✗ Attempt ${attempt}: [${err.code || status || 'ERROR'}] ${err.message}`);
      if (errData) console.log(`    NIM body:`, JSON.stringify(errData).substring(0, 500));

      if (attempt < 3) {
        const delay = attempt * 5000;
        console.log(`    Retry in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error('  ✗ All 3 attempts failed');

  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: mdl,
      choices: [{ index: 0, delta: { content: `[Error: ${lastError?.message || 'Unknown error'}]` }, finish_reason: 'stop' }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.status(lastError?.response?.status || 500).json({
      error: {
        message: lastError?.message || 'Internal server error',
        type: 'invalid_request_error',
        code: lastError?.response?.status || 500
      }
    });
  }
});

// ── Start server with extended timeouts ─────────────────

const server = app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`MAX_HISTORY: ${MAX_HISTORY} messages`);
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;
