import { Problem } from './domain.mjs';

/** @typedef {{output:string, model:string, inputTokens:number|null, outputTokens:number|null, latency:number}} Completion */

export async function generate(config, instructions, inputs) {
  const started = performance.now();
  let result;
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      headers:{Authorization:'Bearer '+config.aiKey,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:config.aiModel, store:false, max_output_tokens:3000,
        instructions,
        input:JSON.stringify(inputs)
      }),
      signal:AbortSignal.timeout(40_000)
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new Problem(502,'AI generation is temporarily unavailable. Try again or paste an output.');
  }
  const output = result.output?.flatMap(message => message.content || [])
    .filter(part => part.type === 'output_text').map(part => part.text).join('\n').trim();
  if (result.status !== 'completed' || !output || output.length > 30_000) throw new Problem(502,'AI generation did not finish. Shorten the input or paste an output.');
  const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {output, model:result.model || config.aiModel, inputTokens:tokenCount(result.usage?.input_tokens),
    outputTokens:tokenCount(result.usage?.output_tokens), latency:Math.round(performance.now()-started)};
}
