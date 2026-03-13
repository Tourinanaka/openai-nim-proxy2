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
    let inThink = false;          // our <think> wrapper is open
    let hadReasoning = false;     // we saw reasoning_content at some point
    let droppingReplay = false;   // currently inside a <think> block in content (duplicate)

    const flushThinkClose = () => {
      if (!inThink) return;
      inThink = false;
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: '\n</think>\n\n' }, index: 0 }]
      })}\n\n`);
    };

    nimRes.data.on('data', (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.includes('[DONE]')) {
          flushThinkClose();
          res.write('data: [DONE]\n\n');
          return;
        }

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (!delta) { res.write(`data: ${JSON.stringify(data)}\n\n`); continue; }

          let r = delta.reasoning_content || '';
          let c = delta.content || '';
          let out = '';

          // ── reasoning_content → wrap in <think> (the REAL thinking stream) ──
          if (r) {
            hadReasoning = true;
            if (!inThink) { out += '<think>\n' + r; inThink = true; }
            else { out += r; }
          }

          // ── content → strip the duplicate <think>…</think> replay ──
          if (c) {
            if (inThink) { out += '\n</think>\n\n'; inThink = false; }

            // start dropping when we hit the replayed <think> block
            if (!droppingReplay && hadReasoning && c.includes('<think>')) {
              droppingReplay = true;
              const idx = c.indexOf('<think>');
              out += c.slice(0, idx);        // keep anything before <think> (usually nothing)
              c = c.slice(idx + 7);          // skip past <think>
            }

            if (droppingReplay) {
              if (c.includes('</think>')) {
                c = c.slice(c.indexOf('</think>') + 8); // keep only text AFTER </think>
                droppingReplay = false;
              } else {
                c = '';                       // still inside replay → drop
              }
            }

            out += c;
          }

          delta.content = out;
          delete delta.reasoning_content;

          const fr = data.choices?.[0]?.finish_reason;
          if (out || fr) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        } catch (e) {}
      }
    });

    nimRes.data.on('end', () => { flushThinkClose(); res.end(); });
    nimRes.data.on('error', () => { flushThinkClose(); res.end(); });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(err.response?.status || 500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => console.log(`NIM Proxy on port ${PORT}`));
