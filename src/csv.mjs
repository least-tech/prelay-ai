import { bad, field, number, sha } from './domain.mjs';

const columns = ['run_id','agent','prompt_category','model','input_tokens','output_tokens','latency_ms'];
const optional = ['cost_usd','event_id'];
function records(text) {
  const result = [];
  let row = [];
  let value = '';
  let quoted = false;
  let closed = false;
  text = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  for (let i = 0; i <= text.length; i++) {
    const char = i === text.length ? '\n' : text[i];
    if (quoted) {
      if (char === '"' && text[i+1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ',' || char === '\n') {
      row.push(value);
      value = '';
      closed = false;
      if (char === '\n') {
        if (row.some(cell => cell.trim())) result.push(row);
        row = [];
        if (result.length > 501) bad('Import up to 500 usage rows at a time.');
      }
    } else if (closed) bad('Unexpected text after a quoted CSV cell.');
    else if (char === '"' && !value) quoted = true;
    else if (char === '"') bad('Unexpected quote in CSV.');
    else value += char;
  }
  if (quoted) bad('A quoted CSV cell was not closed.');
  return result;
}

export function usageRows(text) {
  const [header,...body] = records(field(text,'CSV',110000));
  if (!header || !body.length) bad('Include a header and at least one data row.');
  const names = header.map(name => name.trim());
  if (new Set(names).size !== names.length || columns.some(name => !names.includes(name))
      || names.some(name => !columns.includes(name) && !optional.includes(name))) bad('Use the documented CSV headers.');
  return body.map((cells,index) => {
    const label = 'Row ' + (index+2);
    if (cells.length !== names.length) bad(label + ' has the wrong number of columns.');
    const row = Object.fromEntries(names.map((name,i) => [name,cells[i].trim()]));
    const values = {
      runId: field(row.run_id,label+' run ID',36),
      agent: field(row.agent,label+' agent',100,false),
      category: field(row.prompt_category,label+' prompt category',100,false),
      model: field(row.model,label+' model',120),
      input: number(row.input_tokens,label+' input tokens',{integer:true}),
      output: number(row.output_tokens,label+' output tokens',{integer:true}),
      latency: number(row.latency_ms,label+' latency',{integer:true}),
      cost: number(row.cost_usd,label+' USD cost',{max:100000})
    };
    const event = field(row.event_id,label+' event ID',120,false);
    return {...values, fingerprint:'csv:'+sha(event ? 'event:'+event : JSON.stringify(values))};
  });
}
