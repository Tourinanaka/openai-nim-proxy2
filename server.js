const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_KEY = process.env.NIM_API_KEY;

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'claude-3-sonnet', object: 'model', created: Date.now(), owned_by: 'nim-proxy' }]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, temperature, max_tokens } = req.body;

    const nimRes = await axios.post(`${NIM_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages,
      temperature: temperature ?? 0.85,
      max_tokens: max_tokens ?? 9024,
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false
      },
      stream: true
    }, {
      headers: { 'Authorization': `Bearer ${NIM_KEY}`, 'Content-Type': 'application/json' },
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let sseBuffer = '';
    let inThink = false;
    let hadReasoning = false;
    let contentAccum = '';      // buffer ALL content chunks
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;

      // close <think> if still open
      if (inThink) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: '\n</think>\n\n' }, index: 0 }]
        })}\n\n`);
      }

      let clean = contentAccum;

      // only strip if we already streamed thinking from reasoning_content
      if (hadReasoning) {
        clean = clean.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      if (clean) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: clean }, index: 0 }]
        })}\n\n`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    };

    nimRes.data.on('data', (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.includes('[DONE]')) { finish(); return; }

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          let r = delta.reasoning_content || '';
          let c = delta.content || '';

          // ── stream reasoning immediately ──
          if (r) {
            hadReasoning = true;
            let out = '';
            if (!inThink) { out = '<think>\n' + r; inThink = true; }
            else { out = r; }
            delta.content = out;
            delete delta.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }

          // ── buffer content, don't send yet ──
          if (c) {
            contentAccum += c;
          }
        } catch (e) {}
      }
    });

    nimRes.data.on('end', () => finish());
    nimRes.data.on('error', () => finish());

  } catch (err) {
    console.error('Error:', err.message);
    res.status(err.response?.status || 500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => console.log(`NIM Proxy on port ${PORT}`));
