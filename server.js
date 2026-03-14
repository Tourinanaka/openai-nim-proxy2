const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_KEY = process.env.NIM_API_KEY;

function prepareMessages(messages) {
  return messages.map(msg => {
    let content = typeof msg.content === 'string' ? msg.content : '';
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    return { role: msg.role, content: content || '(continue)' };
  });
}

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

    const nimRes = await axios.post(`${NIM_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages: preparedMessages,
      temperature: temperature ?? 0.85,
      max_tokens: max_tokens ?? 9000,
      chat_template_kwargs: {
        thinking: true,
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

    // --- line break engine (2-char sliding window) ---
    let tail = '';
    let nlRun = 0;

    function needsBreak(a, sep, c) {
      if (sep === ' ') {
        // . ! ? then "   →  paragraph before dialogue
        if (/[.!?]/.test(a) && c === '"') return true;
        // . ! ? " ' * then *   →  paragraph before action
        if (/[.!?"'*]/.test(a) && c === '*') return true;
        // * then A-Z or "   →  paragraph after action
        if (a === '*' && /[A-Z"]/.test(c)) return true;
        // " ' then A-Z   →  paragraph after dialogue
        if (/["']/.test(a) && /[A-Z]/.test(c)) return true;
      }
      if (sep === '\n') {
        // single \n before " or * → upgrade to \n\n
        if (a !== '\n' && (c === '"' || c === '*')) return true;
        if (/["']/.test(a) && /[A-Z*]/.test(c)) return true;
      }
      return false;
    }

    function fixBreaks(text) {
      tail += text;
      let raw = '';
      while (tail.length >= 3) {
        if (needsBreak(tail[0], tail[1], tail[2])) {
          raw += tail[0] + '\n\n';
          tail = tail.slice(2);   // skip the space/\n, keep char c
        } else {
          raw += tail[0];
          tail = tail.slice(1);
        }
      }
      // collapse 3+ newlines → 2
      let out = '';
      for (const ch of raw) {
        if (ch === '\n') { nlRun++; if (nlRun <= 2) out += '\n'; }
        else { nlRun = 0; out += ch; }
      }
      return out;
    }

    function flushTail() {
      let out = '';
      for (const ch of tail) {
        if (ch === '\n') { nlRun++; if (nlRun <= 2) out += '\n'; }
        else { nlRun = 0; out += ch; }
      }
      tail = '';
      return out;
    }
    // --- end line break engine ---

    nimRes.data.on('data', (chunk) => {
      sseBuffer += chunk.toString();
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        if (line.includes('[DONE]')) continue;   // sent on 'end'

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          let r = (delta.reasoning_content || '').replace(/\\n/g, '\n');
          let c = (delta.content || '').replace(/\\n/g, '\n');
          let out = '';

          // reasoning → stream live with <think> tags
          if (r && !inThink) { out = '<think>\n' + r; inThink = true; }
          else if (r) { out = r; }

          // transition think → content
          if (c && inThink) { out += '</think>\n\n'; inThink = false; }

          // content → fix line breaks in real-time
          if (c) out += fixBreaks(c);

          const fr = data.choices?.[0]?.finish_reason;
          if (out || fr) {
            delta.content = out || '';
            delete delta.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        } catch (e) {}
      }
    });

    nimRes.data.on('end', () => {
      const remaining = flushTail();
      if (remaining) {
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-3-sonnet',
          choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }]
        })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    nimRes.data.on('error', () => res.end());
  } catch (err) {
    console.error('Error:', err.message);
    res.status(err.response?.status || 500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => console.log(`NIM Proxy on port ${PORT}`));


