const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_KEY = process.env.NIM_API_KEY;

// ── Strip <think> blocks from history before sending to NIM ──
function prepareMessages(messages) {
  return messages.map(msg => {
    let content = typeof msg.content === 'string' ? msg.content : '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { role: msg.role, content: content || '(continue)' };
  });
}

// ── Force linebreaks into wall-of-text output ──
function enforceLineBreaks(text) {
  text = text.replace(/\r\n/g, '\n');

  // CASE 1: Complete wall of text — no double newlines at all
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

  // CASE 2: Has single newlines that should be doubles
  text = text.replace(/([^\n])\n(")/g, '$1\n\n$2');
  text = text.replace(/([^\n])\n(\*)/g, '$1\n\n$2');
  text = text.replace(/(["""'])\n([A-Z*])/g, '$1\n\n$2');

  // Scene breaks and stage directions
  text = text.replace(/([.!?""'*])\s+([-—]{2,})/g, '$1\n\n$2');
  text = text.replace(/([.!?""'*])\s+(\[)/g, '$1\n\n$2');
  text = text.replace(/(\])\s+([A-Z"*])/g, '$1\n\n$2');

  // Collapse 3+ newlines down to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text;
}

// ── Helper: send one SSE chunk ──
function sendSSE(res, id, text, finishReason) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-3-sonnet',
    choices: [{
      index: 0,
      delta: finishReason ? {} : { content: text },
      finish_reason: finishReason || null
    }]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

// ── Routes ──
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'claude-3-sonnet', object: 'model', created: Date.now(), owned_by: 'nim-proxy' }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, temperature, max_tokens } = req.body;
    const preparedMessages = prepareMessages(messages);

    console.log('\n── Turn (stream) ──');
    console.log(`  Messages: ${messages.length}`);

    const nimRes = await axios.post(`${NIM_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages: preparedMessages,
      temperature: temperature ?? 0.85,
      max_tokens: max_tokens ?? 9024,
      chat_template_kwargs: {
        thinking: true,
        enable_thinking: true,
        clear_thinking: false
      },
      stream: true
    }, {
      headers: {
        'Authorization': `Bearer ${NIM_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let sseBuffer = '';
    let thinkOpened = false;
    let contentBuffer = '';         // ← buffer content, DON'T stream it yet
    let streamId = `chatcmpl-${Date.now()}`;

    nimRes.data.on('data', (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.includes('[DONE]')) continue;   // we send our own [DONE] on end

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          if (data.id) streamId = data.id;

          // Fix literal \n that NIM sometimes sends in streaming
          const r = (delta.reasoning_content || '').replace(/\\n/g, '\n');
          const c = (delta.content || '').replace(/\\n/g, '\n');

          // ─ REASONING: stream live so user sees activity ─
          if (r) {
            if (!thinkOpened) {
              sendSSE(res, streamId, '<think>\n' + r, null);
              thinkOpened = true;
            } else {
              sendSSE(res, streamId, r, null);
            }
          }

          // ─ CONTENT: buffer silently for post-processing ─
          if (c) {
            contentBuffer += c;
          }
        } catch (e) {}
      }
    });

    nimRes.data.on('end', () => {
      // ── Close think tag ──
      if (thinkOpened) {
        sendSSE(res, streamId, '\n</think>\n\n', null);
      }

      // ── Apply line break fix on full content ──
      contentBuffer = enforceLineBreaks(contentBuffer);

      // ── Re-emit fixed content as SSE chunks ──
      const CHUNK_SIZE = 8;
      for (let i = 0; i < contentBuffer.length; i += CHUNK_SIZE) {
        sendSSE(res, streamId, contentBuffer.slice(i, i + CHUNK_SIZE), null);
      }

      // ── Finish ──
      sendSSE(res, streamId, '', 'stop');
      res.write('data: [DONE]\n\n');
      res.end();

      const paras = (contentBuffer.match(/\n\n/g) || []).length + 1;
      console.log(`  [done] len=${contentBuffer.length} paragraphs=${paras} think=${thinkOpened}`);
    });

    nimRes.data.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.end();
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(err.response?.status || 500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => console.log(`NIM Proxy on port ${PORT}`));
