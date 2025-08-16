import type { Env } from "../config/env";
import type { UiMessage } from "../twilio/helpers";
import { owrError } from "../utils/log";

export async function generateTextDirect(
  env: Env,
  messages: UiMessage[],
  systemPrompt: string
): Promise<string> {
  try {
    const openaiMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.parts.map(part => part.text).join('')
    }));

    const model = 'gpt-5';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...openaiMessages
        ],
        temperature: 0.8,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    return data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
  } catch (error) {
    owrError('Direct text generation failed:', error);
    return 'Sorry, I\'m currently under maintenance.';
  }
}


