import type { Env } from "../config/env";
import type { UiMessage } from "../twilio/helpers";
import { rackyError, rackyLog } from "../utils/log";

export async function generateTextDirect(
  env: Env,
  messages: UiMessage[],
  systemPrompt: string
): Promise<string> {
  try {
    const openaiMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.parts.map((part) => part.text).join(""),
    }));

    const model = "gpt-4.1";

    rackyLog("openaiMessages", JSON.stringify(openaiMessages, null, 2));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...openaiMessages,
        ],
        temperature: 0.8,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    return (
      data.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response."
    );
  } catch (error) {
    rackyError("Direct text generation failed:", error);
    return "Sorry, I'm currently under maintenance.";
  }
}

// import type { Env } from "../config/env";
// import type { UiMessage } from "../twilio/helpers";
// import { rackyError } from "../utils/log";

// export async function generateTextDirect(
//   env: Env,
//   messages: UiMessage[],
//   systemPrompt: string
// ): Promise<string> {
//   try {
//     const openaiInput = [
//       {
//         role: "system",
//         content: [{ type: "input_text", text: systemPrompt }],
//       },
//       ...messages.map((msg) => ({
//         role: msg.role,
//         content: msg.parts.map((part) => ({
//           type: "input_text",
//           text: part.text,
//         })),
//       })),
//     ];

//     const model = "gpt-5";

//     const response = await fetch("https://api.openai.com/v1/responses", {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${env.OPENAI_API_KEY}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         model,
//         input: openaiInput,
//         temperature: 0.8,
//         max_output_tokens: 1000,
//       }),
//     });

//     if (!response.ok) {
//       throw new Error(`OpenAI API error: ${response.status}`);
//     }

//     const data = (await response.json()) as {
//       output_text?: string;
//       output?: Array<{
//         content?: Array<{ type?: string; text?: string }>;
//       }>;
//     };

//     const textFromOutputArray = (data.output || [])
//       .flatMap((item) => item.content || [])
//       .map((c) => c?.text)
//       .filter((t): t is string => Boolean(t))
//       .join(" ")
//       .trim();

//     return (
//       data.output_text ||
//       textFromOutputArray ||
//       "Sorry, I could not generate a response."
//     );
//   } catch (error) {
//     rackyError("Direct text generation failed:", error);
//     return "Sorry, I'm currently under maintenance.";
//   }
// }
