const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const FORMAT_INSTRUCTION = `

[IMPORTANT — OUTPUT FORMATTING]
You MUST use blank lines between every paragraph, between narration and dialogue,
and between each character action. Never combine multiple paragraphs into one
unbroken block of text. Use double linebreaks (\\n\\n) to separate sections.`;

function prepareMessages(messages) {
  const cleaned = messages.map(msg => {
    const content = typeof msg.content === 'string' ? msg.content : '';

    // Strip <think> blocks from history so they don't pile up
    const stripped = content
      .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
      .trim();

    return {
      role: msg.role,
      content: stripped || '...'
    };
  });

  const sysIdx = cleaned.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    cleaned[sysIdx].content += FORMAT_INSTRUCTION;
  } else {
    cleaned.unshift({ role: 'system', content: FORMAT_INSTRUCTION.trim() });
  }

  return cleaned;
}

function normalizeLineBreaks(text) {
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/([^\n])\n(?=\")/g, '$1\n\n');
  text = text.replace(/([^\n])\n(?=\*)/g, '$1\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
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
  try {
    const { model, messages, temperature, max_tokens } = req.body;

    const preparedMessages = prepareMessages(messages);

    console.log('\n── Incoming turn ──');
    messages.slice(-2).forEach(m => {
      const preview = (m.content || '').substring(0, 120).replace(/\n/g, '\\n');
      console.log(`  [${m.role}] ${preview}…`);
    });

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: 'z-ai/glm5',
      messages: preparedMessages,
      temperature: temperature || 0.85,
      max_tokens: max_tokens || 9024,
      stream: false,
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false          // thinking stays inside content
      }
    }, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'claude-3-sonnet',
      choices: response.data.choices.map(choice => {
        let content = choice.message?.content || '';

        // Split thinking from actual response
        let thinkBlock = '';
        let body = content;

        const thinkMatch = content.match(/^(<think>[\s\S]*?<\/think>)\s*([\s\S]*)$/);
        if (thinkMatch) {
          thinkBlock = thinkMatch[1];
          body = thinkMatch[2];
        }

        // Only normalize linebreaks on the actual response, not the thinking
        body = normalizeLineBreaks(body);

        // Recombine — thinking stays visible
        const finalContent = thinkBlock
          ? thinkBlock + '\n\n' + body
          : body;

        return {
          index: choice.index,
          message: { role: choice.message.role, content: finalContent },
          finish_reason: choice.finish_reason
        };
      }),
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (error) {
    console.error('Proxy error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
